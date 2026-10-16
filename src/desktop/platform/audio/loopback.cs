using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

namespace StudioAudio {
    internal static class Loopback {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        private static volatile bool stopping;

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropertyValue value);

        private static void Write(object value) {
            Console.WriteLine(Json.Serialize(value));
            Console.Out.Flush();
        }

        private static string Name(Device device) {
            Properties properties;
            device.OpenPropertyStore(0, out properties);
            try {
                var key = new PropertyKey { format = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), id = 14 };
                PropertyValue value;
                properties.GetValue(ref key, out value);
                try { return Marshal.PtrToStringUni(value.text) ?? "播放裝置"; }
                finally { PropVariantClear(ref value); }
            } finally { Marshal.ReleaseComObject(properties); }
        }

        private static void List(Enumerator enumerator) {
            var result = new List<object>();
            string defaultId = "";
            try {
                Device device;
                enumerator.GetDefaultAudioEndpoint(0, 1, out device);
                device.GetId(out defaultId);
                Marshal.ReleaseComObject(device);
            } catch (COMException) { }
            Devices devices;
            enumerator.EnumAudioEndpoints(0, 1, out devices);
            try {
                uint count;
                devices.GetCount(out count);
                for (uint index = 0; index < count; index++) {
                    Device device;
                    devices.Item(index, out device);
                    try {
                        string id;
                        device.GetId(out id);
                        var iid = typeof(EndpointVolume).GUID;
                        object instance;
                        device.Activate(ref iid, 23, IntPtr.Zero, out instance);
                        bool muted;
                        float volume;
                        try {
                            var endpoint = (EndpointVolume)instance;
                            endpoint.GetMute(out muted);
                            endpoint.GetMasterVolumeLevelScalar(out volume);
                        } finally { Marshal.ReleaseComObject(instance); }
                        result.Add(new { id, label = Name(device), isDefault = id == defaultId, muted, volume });
                    } finally { Marshal.ReleaseComObject(device); }
                }
            } finally { Marshal.ReleaseComObject(devices); }
            Write(result);
        }

        private static void Capture(Enumerator enumerator, string id) {
            Device device;
            if (id == "") enumerator.GetDefaultAudioEndpoint(0, 1, out device);
            else enumerator.GetDevice(id, out device);
            AudioClient client = null;
            CaptureClient capture = null;
            IntPtr format = IntPtr.Zero;
            bool started = false;
            try {
                var iid = typeof(AudioClient).GUID;
                object instance;
                device.Activate(ref iid, 23, IntPtr.Zero, out instance);
                client = (AudioClient)instance;
                client.GetMixFormat(out format);
                int tag = (ushort)Marshal.ReadInt16(format, 0);
                int channels = (ushort)Marshal.ReadInt16(format, 2);
                int rate = Marshal.ReadInt32(format, 4);
                int block = (ushort)Marshal.ReadInt16(format, 12);
                int bits = (ushort)Marshal.ReadInt16(format, 14);
                if (tag == 65534) tag = Marshal.ReadInt32(format, 24);
                if (channels < 1 || rate < 8000 || rate > 192000 ||
                    !(tag == 3 && bits == 32 || tag == 1 && (bits == 16 || bits == 24 || bits == 32)))
                    throw new InvalidOperationException("播放裝置的音訊格式不支援擷取");
                client.Initialize(0, 0x20000, 1000000, 0, format, IntPtr.Zero);
                iid = typeof(CaptureClient).GUID;
                client.GetService(ref iid, out instance);
                capture = (CaptureClient)instance;
                client.Start();
                started = true;
                Write(new { type = "ready", sampleRate = rate });
                var input = new Thread(() => { Console.ReadLine(); stopping = true; });
                input.IsBackground = true;
                input.Start();
                while (!stopping) {
                    uint packet;
                    capture.GetNextPacketSize(out packet);
                    if (packet == 0) { Thread.Sleep(5); continue; }
                    IntPtr data;
                    uint frames, flags;
                    ulong position, counter;
                    capture.GetBuffer(out data, out frames, out flags, out position, out counter);
                    try {
                        var raw = new byte[checked((int)frames * block)];
                        if ((flags & 2) == 0) Marshal.Copy(data, raw, 0, raw.Length);
                        var mono = new float[frames];
                        for (int frame = 0; frame < frames; frame++) {
                            double sum = 0;
                            for (int channel = 0; channel < channels; channel++) {
                                int offset = frame * block + channel * (bits / 8);
                                if (tag == 3) sum += BitConverter.ToSingle(raw, offset);
                                else if (bits == 16) sum += BitConverter.ToInt16(raw, offset) / 32768.0;
                                else if (bits == 32) sum += BitConverter.ToInt32(raw, offset) / 2147483648.0;
                                else sum += ((raw[offset] << 8 | raw[offset + 1] << 16 | raw[offset + 2] << 24) >> 8) / 8388608.0;
                            }
                            mono[frame] = (float)Math.Max(-1, Math.Min(1, sum / channels));
                        }
                        var bytes = new byte[mono.Length * 4];
                        Buffer.BlockCopy(mono, 0, bytes, 0, bytes.Length);
                        Write(new { type = "audio", samples = Convert.ToBase64String(bytes) });
                    } finally { capture.ReleaseBuffer(frames); }
                }
            } finally {
                if (started) client.Stop();
                if (capture != null) Marshal.ReleaseComObject(capture);
                if (client != null) Marshal.ReleaseComObject(client);
                if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
                Marshal.ReleaseComObject(device);
            }
        }

        [MTAThread]
        private static int Main(string[] args) {
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            try {
                var enumerator = (Enumerator)new EnumeratorClass();
                try {
                    if (args.Length == 1 && args[0] == "list") List(enumerator);
                    else if (args.Length == 2 && args[0] == "capture") Capture(enumerator, args[1]);
                    else throw new ArgumentException("無效的音訊操作");
                } finally { Marshal.ReleaseComObject(enumerator); }
                return 0;
            } catch (Exception error) {
                Write(new { type = "error", message = String.Format("無法擷取播放裝置，請確認裝置仍已連接且未被獨佔：{0}", error.Message) });
                return 1;
            }
        }
    }
}
