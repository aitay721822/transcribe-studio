using System;
using System.Runtime.InteropServices;

// COM declarations preserve native vtable order, including unused methods.
namespace StudioAudio {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class EnumeratorClass { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface Enumerator {
        void EnumAudioEndpoints(int flow, uint mask, out Devices devices);
        void GetDefaultAudioEndpoint(int flow, int role, out Device device);
        void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out Device device);
        void RegisterEndpointNotificationCallback(IntPtr callback);
        void UnregisterEndpointNotificationCallback(IntPtr callback);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface Devices {
        void GetCount(out uint count);
        void Item(uint index, out Device device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface Device {
        void Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        void OpenPropertyStore(uint access, out Properties properties);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetState(out uint state);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey {
        public Guid format;
        public uint id;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    internal struct PropertyValue {
        [FieldOffset(0)] public ushort type;
        [FieldOffset(8)] public IntPtr text;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface Properties {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropertyValue value);
        void SetValue(ref PropertyKey key, ref PropertyValue value);
        void Commit();
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface AudioClient {
        void Initialize(int mode, uint flags, long duration, long periodicity, IntPtr format, IntPtr session);
        void GetBufferSize(out uint frames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
        void GetMixFormat(out IntPtr format);
        void GetDevicePeriod(out long normal, out long minimum);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr handle);
        void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface CaptureClient {
        void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong counter);
        void ReleaseBuffer(uint frames);
        void GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface EndpointVolume {
        void RegisterControlChangeNotify(IntPtr callback);
        void UnregisterControlChangeNotify(IntPtr callback);
        void GetChannelCount(out uint count);
        void SetMasterVolumeLevel(float value, IntPtr context);
        void SetMasterVolumeLevelScalar(float value, IntPtr context);
        void GetMasterVolumeLevel(out float value);
        void GetMasterVolumeLevelScalar(out float value);
        void SetChannelVolumeLevel(uint channel, float value, IntPtr context);
        void SetChannelVolumeLevelScalar(uint channel, float value, IntPtr context);
        void GetChannelVolumeLevel(uint channel, out float value);
        void GetChannelVolumeLevelScalar(uint channel, out float value);
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool value, IntPtr context);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool value);
    }
}
