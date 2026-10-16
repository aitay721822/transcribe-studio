# Harness 架構

應用程式透過 `ai/contracts.ts` 的 `HarnessAdapter.execute(context)` 執行修訂。預設為 OpenAI API；只有選擇 Codex 或 Claude Code 才啟動對應 runtime。UI、會議資料與 persistence 不依賴任何 vendor 協定。

`harness/coordinator.ts` 負責執行生命週期：建立文件快照、準備 skills 與 MCP、限制時間／工具呼叫、取消、保存事件、回傳版本綁定的修訂提案。`harness/input/scheduler.ts` 持有每場會議的 FIFO 與目前 run，確保同場會議只執行一輪；不同會議可獨立執行。`tools.ts` 負責工具路由與 JSON Schema 驗證，`approvals.ts` 負責確認流程，`prompt.ts` 負責會議指令，`skills.ts` 負責技能發現。工具連線交給 `transport/mcp.ts`。

## Queue 與 steer

`agent:submit(request, mode, expectedRunId)` 接收輸入並回覆處置結果，執行結果由 `agent:event` 發送。`queue` 在下一輪執行；`steer` 必須指定目前 run ID，避免遲到的訊息改到其他工作。每場會議最多排隊 20 則，輸入先寫入 JSONL 的 run-state，再回覆接收。拒絕的 steer 追加 `steer-rejected` 事件並保留在 FIFO，接受的 steer 保存 `steered` 狀態與目前 run 的追加指令。

| 後端 | steer 接入 |
| --- | --- |
| Codex | 原生 `turn/steer`，使用目前 `expectedTurnId`，只傳 input，不更改模型／工作區；原生拒絕或完成競態時回到共用佇列 |
| Claude Code | 本機 `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`；stdin 保持開啟以追加輸入，等待追加訊息被 CLI 消費後才採用最終 result；取消會終止程序樹 |
| OpenAI API | 將追加指令放入下一次 Responses request；若正在取得最後答案，會再次請求以納入指令，再發布提案 |

停止目前工作會暫停其佇列；可移除個別待執行訊息或按「繼續佇列」。停止期間尚在傳送的 steer 即使收到遲到的成功回覆，仍會保留在佇列。關閉程式保存待執行項目；重開後明確按繼續才執行。服務錯誤也會暫停後續項目。每輪開始時重新讀取已儲存文件、版本、設定與工具資料；相同文件版本的上一輪未套用提案可作為背景，仍須由使用者檢查／套用。

設計參考：[Codex app-server 協定](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)、[DeepWiki queue／steer 分析](https://deepwiki.com/search/for-a-client-implementing-turn_d5d601b9-3644-4319-8150-3a532c736e52)、[Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)。本應用自行持有跨後端佇列，未直接引入 Codex Rust runtime。

## 首次設定與本機偵測

語音辨識或 Agent 缺少必要欄位時，啟動進入三步設定導覽；未找到所選本機 CLI 時亦會引導設定。可從設定頁重新開啟導覽。必要欄位檢查不代表已通過遠端認證，實際模型權限／連線在使用服務時確認。

`services/agents/executable.ts` 掃描 PATH、Windows PATHEXT、npm 目錄與常見安裝路徑；標準 npm shim 解析為套件 bin 後直接啟動，不執行 shell 字串。可透過設定路徑或 `STUDIO_CODEX_PATH`／`STUDIO_CLAUDE_PATH` 指定。`detection.ts` 對 Codex 與 Claude Code 並行探測 `--version`，每候選最多 4 秒、每後端最多 3 個，並限制輸出。UI 分別顯示安裝、可啟動與 CLI 登入狀態。Codex 透過 app-server 的 `account/read` 與 `model/list` 偵測；Claude 使用 `auth status --json`。不讀取或複製登入憑證檔案。偵測不到認證格式時顯示未知，不將版本成功誤判為已登入。Claude 的 API 與 CLI 模式皆需先安裝外部 Claude Code；Studio 不隨附執行檔。

參考：[Multica 的公開原始碼](https://github.com/multica-ai/multica/blob/main/server/internal/daemon/agents_probe.go)、[DeepWiki 本機偵測分析](https://deepwiki.com/search/summarize-local-agent-cli-disc_52e9de4d-82be-46b9-93ea-54e1de92b210)。本應用沿用其 PATH／常見位置／有界探測概念，新增 CLI 登入與 API key 兩種明確模式，連線失敗不自動切換計費方式。

## Adapters

| 後端 | 實作 | Context 與續接 | 必要設定 |
| --- | --- | --- | --- |
| OpenAI API | 本應用的 Responses function-calling loop，`store:false` | 每次使用目前文件快照、已保存摘要、尚未摘要的最近 12 則要求與按需工具資料；執行中可摘要較舊的完整工具回合 | Responses Base URL、API key、model |
| Codex | 本機 `codex app-server`，JSONL stdin/stdout transport | native thread/turn/resume/interrupt；compaction 由 Codex runtime 管理 | CLI 模式沿用登入及模型；API 模式另填 Base URL、key、model |
| Claude Code | 本機 `claude -p`，每輪專用 loopback HTTP MCP gateway 呼叫共用工具 | 指定 session ID resume；context 管理由 Claude CLI 負責 | CLI 模式沿用登入及模型；API 模式另填 key、model |

Codex 與 Claude 的 session 綁定分別存於會議 JSONL，fingerprint 包含認證模式、可取得的帳號識別雜湊、模型、工作區、工具 schema、指令及輸出 schema。不同會議使用不同 session；切換帳號／模式／工具會建立新 session。CLI 模式沿用使用者的 `CODEX_HOME`／`CLAUDE_CONFIG_DIR` 或預設目錄；API 模式保留專案隔離的 home。Studio 不修改全域設定、不複製 token，憑證更新交給 CLI。既有原生 session cache 不自動刪除。

設定使用 `codexAuth`／`claudeAuth`（`cli` 或 `api`）；舊設定有 key 而沒有 mode 時沿用 API 行為，沒有 key 則預設 CLI。Codex 的 `codexModel` 與 API 的 `model` 分開，避免舊 API 模型污染 CLI 預設。CLI 模式不要求 key、Base URL 或模型；模型空白沿用 CLI。切換 UI 模式保留加密的 API 設定。尚未登入、認證失效、額度、模型權限及網路錯誤分開提示。

連線測試採用 Codex ephemeral thread／Claude `--no-session-persistence`，只清除 Studio 自己的測試目錄。Windows 會等待 npm wrapper 與原生子程序全部關閉後才清理，避免 EBUSY；不刪除共用 CLI home。

Windows 的版本／登入偵測與 Agent 執行統一經過 `transport/runtime/launch.ts`。建置時將 `hidden-host.cs` 編譯為 GUI 啟動器，使用 `CREATE_NEW_CONSOLE` 與 `STARTF_USESHOWWINDOW/SW_HIDE` 建立 CLI 的隱藏主控台，讓一般子程序繼承隱藏狀態；不僅設定不會繼承的 `windowsHide`。npm JavaScript 入口使用安裝位置或 PATH 的 `node.exe`，避免 GUI subsystem 的 Electron 無法繼承主控台。原生 CLI 不要求 Node。啟動器的 stdin/stdout/stderr、環境、工作目錄與結束碼完整傳遞，封裝時置於 `app.asar.unpacked/dist/native`；Windows 建置使用系統的 .NET Framework C# compiler。

所有後端使用相同工作區工具與技能規則。MCP 由本應用 SDK 連線，再映射至 Codex dynamic tools、Claude 本機 HTTP MCP gateway 或 OpenAI functions；不是複製 Codex 的 Rust MCP manager。Skills 使用 `.agents/skills`、`.codex/skills`、`.claude/skills` 的 SKILL.md：清單先提供 metadata，完整指令可由工具讀取；指定 skill 會隨該次要求提供內容。不執行 skill 腳本。

OpenAI 使用應用端摘要壓縮，透過目前 Responses 端點產生有界摘要；未要求相容端點支援專用 /responses/compact API。各後端亦可用 /compact 分批整理已保存的對話與工具資料，成功後持久保存摘要並重設原生 session。壓縮模型請求計入本輪預算；失敗或取消不替換記憶。/clear 以 JSONL 重設界線清空目前對話，保留全部原始紀錄。大量逐字稿透過分頁搜尋取用；原稿超過 80,000 字會要求拆分。每次執行在開始時擷取時間、工具及模型回合上限。時間預設 30 分鐘，可設 0–1,440 分鐘（0 不限）；工具可設 0–10,000 次（0 不限）；模型回合可設 1–10,000。舊版未設定獨立工具上限時，沿用 maxSteps。OpenAI 的模型請求及 Claude turns 受模型回合限制；Codex 的原生回合不套用此數值，但仍受時間與工具上限限制。共同 coordinator 為每次工具呼叫建立 callId、起訖時間、耗時及完成／錯誤／取消狀態，參數及完整工具回應沿用 JSONL 保存。UI 將輸入與結果配對，展開才渲染 JSON；agent:trace 可恢復最近一次執行的完整明細。MCP 連線與每次呼叫均要求確認，並將確認與決定寫入 JSONL。

Codex adapter 關閉 shell/unified_exec 等開發工具並設定 read-only；Claude CLI 模式只讀取 user 設定以沿用認證及預設模型，API 模式不載入 user 設定；停用 hooks、slash commands 及 built-in tools，使用 strict MCP config，僅開放本輪帶隨機 Bearer 憑證的會議 gateway。不使用 `--bare`，因為該模式會停用訂閱登入。輸出的提案需經使用者套用，並比對文件版本。外部 MCP 程序依然具有它自己的 OS 權限。

## Codex 參考對照

以下是借用的架構概念，並非宣稱三個後端都有相同的原生行為。

| Codex source | 本應用對應 |
| --- | --- |
| `codex-rs/core/src/session/turn.rs` | coordinator 的 run lifecycle；各 adapter 執行 model/tool loop |
| `codex-rs/core/src/tools/router.rs` | 共用工具 registry、路由與參數驗證 |
| `codex-rs/codex-mcp/src/connection_manager.rs` | 獨立 MCP transport，與 UI/模型 adapter 分離 |
| `codex-rs/rollout/src/recorder.rs` | append-only JSONL conversation journal |
| `codex-rs/core/src/skills/mod.rs` | skill metadata 與按需載入 |
| `codex-rs/core/src/compact.rs` | 原生 Codex adapter 自行處理並傳遞事件；OpenAI 另有應用端摘要，保留原始要求、近期完整工具回合及原始 JSONL |

來源：[DeepWiki 針對抽象 harness 的拆解](https://deepwiki.com/search/we-are-implementing-a-typescri_02397ef4-3e93-4a95-a8a6-8d649fd2d298)、[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[Claude Agent SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)、[Claude structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)、[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)。Codex 已以本機 CLI 0.162.1 的登入完成免 key 實際連線；Claude CLI -p 已以 2.1.268 搭配本機模擬 API 驗證工具呼叫、串流追加與 session resume；dynamic tools 是 experimental API，升級 CLI 後須重跑協定測試。

## 目錄與 SRP

`src/main.ts` 是唯一外層來源檔，只組裝平台生命周期與各模組。`domain` 定義資料模型，`desktop` 處理 Electron 視窗、設定及分組 IPC；`ui` 處理渲染、互動及音訊擷取；`services` 分別處理工作區文件、文件格式與字幕；`transport` 負責 ASR、MCP、Codex RPC 與 preload bridge；`persistence` 負責 SQLite 與 JSONL；`ai` 放後端介面及 adapters；`harness` 放共用執行規則。

UI 全面使用 React／TSX。`ui/app.tsx` 組裝 runtime、控制器與 IPC 訂閱；`ui/application/pages` 按 chrome、library、audio、meeting、settings 拆分頁面，`ui/layout` 管理側欄與工作台的 resizable panels、dialog／popover 生命周期及通知。`ui/audio/controller.tsx` 管理錄音與音檔操作，`ui/agent/controller.tsx` 管理 Agent 對話與提案。控制器透過型別化依賴接入，不反向依賴 app 入口。

所有頁面、SVG 圖示、Markdown 預覽、dialog、搜尋、專案選單與設定導覽都直接輸出 JSX；已移除 HTML 模板解析與 innerHTML 渲染。Button／Input／Textarea 採用 shadcn/ui 的 owned-source 元件，Select 是 React 管理的可搜尋下拉選單，保留原生表單值、disabled、群組及鍵盤操作。`useSyncExternalStore` 驅動 IPC 資料更新；筆記使用受控 textarea，串流與 resize 保留 DOM 節點、輸入草稿及選取範圍，切換會議才重設工作台。導覽、搜尋、專案編輯器與音量測試用 hooks 管理狀態及清理資源；音量動畫以 refs 在 requestAnimationFrame 更新 transform。

Tailwind v4 透過 `scripts/build/styles.cjs` 的 PostCSS 建置整合，掃描 `src/ui` 並輸出 dist/ui/styles/tailwind.css。shadcn 語意 token 對應既有 theme 變數；不載入 Preflight，保留自訂玻璃材質、排版與原生視窗樣式。shadcn 設定位於 `src/ui/components.json`，以 UI 作為工作目錄；別名由 root tsconfig 的 `@/*` 指向 `src/ui/*`。參考：[Tailwind PostCSS](https://tailwindcss.com/docs/installation/using-postcss)、[shadcn 手動整合](https://ui.shadcn.com/docs/installation/manual)。

`styles/base.css` 僅按原有順序引入 foundation、surfaces、workspace、agent 與 dialogs 樣式，確保拆分前後的 cascade 一致。音訊來源與測試生命週期分別位於 `ui/audio/sources.ts`、`meter.ts`。專案資料清除位於 `services/projects/lifecycle.ts`，先驗證應用程式擁有的絕對路徑，才移除對應資料。

`npm run build` 會檢查維護中的來源與根目錄（自動涵蓋新增的來源目錄）：每個文字來源檔最多 500 行（包含空白行）、每個資料夾最多 10 個檔案與 10 個子資料夾，src 外層只能有 main.ts。第三方 node_modules、package-lock 及 dist/release/output 產物不計入來源行數規則。編譯後的 dist 使用相同業務分組，source map 內嵌，避免額外檔案超限。
