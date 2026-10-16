# JSONL 對話儲存

每場會議使用 userData/conversations/<meeting-id>.jsonl。每行都是獨立 UTF-8 JSON 物件，以換行結尾。SQLite 保存專案、會議、逐字稿、文件版本與加密設定；使用者對話、Agent events、執行狀態與 provider session 綁定存於 JSONL。

```json
{"schemaVersion":1,"id":"record-uuid","timestamp":"2026-10-13T09:00:00.000Z","type":"message","data":{"text":"整理決議與待辦","createdAt":"2026-10-13T09:00:00.000Z"}}
{"schemaVersion":1,"id":"event-uuid","timestamp":"2026-10-13T09:00:01.000Z","type":"run-event","data":{"runId":"run-uuid","event":{"type":"tool-result","name":"studio_read_notes","result":{"notes":"原稿","version":1}}}}
```

| type | 用途 |
| --- | --- |
| message | 使用者對話內容 |
| run-event | 要求與選取文字、工具呼叫／結果、確認／決定、修訂提案及錯誤 |
| run-state | 執行狀態、backend、文件版本、session id、最終提案與待執行 input；不重複完整事件陣列 |
| session | 各 backend 的 session id、fingerprint 與隔離 runtime 位置 |
| context-memory | 成功壓縮的摘要、已涵蓋訊息數與最後來源紀錄 ID；重設先前 session 綁定 |
| conversation-reset | 使用者 `/clear` 的界線；目前聊天、執行、摘要及 session 只讀取界線之後的紀錄 |

寫入以 append + fsync 完成，不覆寫既有對話。重啟會重新載入使用者對話與先前提案；未結束的執行標記為 cancelled。API keys 不寫入 journal，對話與工具結果則包含使用者提供的會議／文件內容。

壓縮先固定來源快照，每批最多 48,000 字元，所有批次成功並通過非空白、長度及縮減檢查才追加 `context-memory`。壓縮期間新增的排隊訊息不會被標記為已摘要；失敗／取消保留原有摘要及 session。完整原始訊息和工具結果不改寫。`conversation-reset` 同樣只追加標記，舊資料仍在 JSONL 中；不具備資料抹除用途。

佇列以 `status:queued` 與完整 `input` 儲存；執行時沿用同一 run ID，追加 running 與終止狀態。已接受的 steer 使用 steered 狀態，並把追加要求記錄在目前 run；被拒絕的 steer 保持 queued 並追加 steer-rejected 事件。重開僅取消原本 running 的工作，queued 保留且暫停，由使用者按「繼續佇列」恢復。每則佇列都會在回覆接收前 fsync。

讀取時若最後一行未完成且 JSON 無效，會截去該尾端再恢復追加；已完整寫入但缺少換行的紀錄會補上換行。中間行損毀會回報錯誤，不靜默丟失資料。

舊版 SQLite 的 chats 與 runs 在啟動時自動遷移：先持久寫入 JSONL，再清除原本的對話欄位／runs rows。重跑遷移不重複已寫入的 messages 或 events。兩種儲存格式之間沒有宣稱具備跨檔案原子交易。

目前讀取與 fsync 在主程序執行，適合中小型會議紀錄。尚未提供多個應用實例同時寫入同一 journal 的跨程序鎖定或大型紀錄索引。
