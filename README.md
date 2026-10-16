# Transcribe Studio

以專案為中心的 TypeScript / Electron 會議記錄助手，第一版優先支援 Windows。

## 啟動

需要 Node.js 22.13 或更新版本。

```powershell
npm install
npm start
```

```powershell
npm run check
npm run format
npm run format:check
npm test
npm run test:ui
npm run package
```

`npm start` 先將 TypeScript 編譯至 dist，再啟動 Electron。`npm run package` 產生 Windows x64 安裝程式 `release/Transcribe Studio Setup 0.3.23.exe`，支援繁體中文／英文、選擇安裝位置、桌面及開始功能表捷徑，並註冊 Windows 解除安裝。預設安裝給目前使用者，也可選擇所有使用者；解除安裝保留會議資料與設定。`npm run package:portable` 仍可產生免安裝版 `release/Transcribe Studio 0.3.23.exe`。`npm run check` 執行 Biome 格式與 lint 檢查（禁止 `any`／`@ts-ignore`）、TypeScript 檢查（`noImplicitAny`、`useUnknownInCatchVariables`）與來源結構驗證：每個文字來源檔最多 500 行，每個來源資料夾最多 10 個檔案／10 個子資料夾。`npm run lint` 執行 Biome 建議的 style 規則（警告也會失敗），並檢查 import 區塊後、函式與方法之間恰好一個空白列；字串插值使用 template literal，數值加法保留。`npm run format` 同時自動整理這些間距，並依 `config/biome.json` 格式化 TypeScript、JavaScript、CSS 與 JSON；排除相依套件、編譯產物與 lockfile。應用未設定 code signing。

UI 全面改為 React／TSX，包含頁面、dialog、搜尋、選單與設定導覽；使用 Tailwind v4 與 shadcn/ui 的 Button、Input、Textarea，以及 React 可搜尋 Select。共用語意色彩對應晨光／夜間／森林主題，保留透明模糊與 rounded layout。欄位驗證錯誤統一使用 error 語意紅色，隨三種主題切換。會議來源面板至少 300px、Agent 面板至少 360px、會議紀錄至少 360px，空間不足時上下排列；標題、分頁與快捷操作維持單行。側欄品牌僅顯示 icon，語音辨識分頁外框與 Tab 按鈕皆採圓角。設定在 `src/ui/components.json`；可用 `npx shadcn@latest info --cwd src/ui` 檢查元件與解析路徑。Tailwind CSS 由 PostCSS 於建置時編譯，不使用 CDN。

SVG 品牌資產位於 `config/branding`：`icon.svg` 為森林綠底圖示、`mark.svg` 為透明單色標誌、`logo.svg` 為橫式 Logo，`preview.html` 可檢視深淺背景及小尺寸。圖形以聲波延伸成筆記橫線，無外部圖像相依；建置時複製 SVG 至 UI，側欄與設定導覽採用相同圖示。

共用 Motion 層位於 `src/ui/components/motion`，採 LazyMotion 與 domAnimation；各 React root 共用動畫規則。頁面淡入、導覽步驟進場與通知進出使用 React Motion；原生 dialog／popover、分頁、按鈕與窄視窗側欄使用 CSS 短動畫（120–200ms）。只在新頁面／步驟掛載時進場，保留編輯器、未送出指令與 ASR 分頁草稿；音量表及拖曳面板不加延遲。即時遵循系統 `prefers-reduced-motion`，停用位移與淡入淡出。`scripts/ui/motion/interactions.cjs` 驗證動態與減少動態偏好、草稿保留、通知退出及側欄焦點／inert。

每次建置會從 `icon.svg` 自動產生 `config/branding/native/icon.ico`（16／24／32／48／64／128／256px）與 `icon.png`，同步套用於 Electron 視窗、Windows EXE、安裝及解除安裝程式。保留 EXE 資源編輯以寫入圖示及版本資訊，僅關閉數位簽章；Windows 工作列識別使用與安裝程式一致的 App ID。

Biome 已啟用 `assist/source/organizeImports`。`npm run format` 使用 `biome check --write` 同時整理匯入及格式；`npm run check` 也會檢查匯入排序，避免未整理的 imports 通過建置前檢查。

所有介面文字最小為 16px，包含提示、快捷鍵、表格、輸入框、對話框與選單。Tailwind 的 xs／sm 字級同樣不小於 16px；窄視窗透過換行、捲動與省略長標題適應版面，不縮小字體。UI 測試會檢查各頁面的實際字級，涵蓋多主題與 480px／1280px 視窗。

Markdown 引用：在編輯器或預覽選取文字，選取位置上方會浮出「標記選取文字」；也可按 Ctrl+Alt+M。操作先開啟回覆視窗，填寫非空白回覆並按「加入訊息框」後，才把原文與回覆卡片放入 Agent 訊息框；取消或尚未確認時不加入。加入不會立即呼叫模型。可加入多段、不重複的引用，移除卡片並保留原有輸入草稿；可再補充其他要求，或直接手動送出已填好的回覆。送出時才建立各引用的標記與精確範圍，OpenAI、Codex、Claude 都只替換指定原文並產生完整提案。檢查提案後才套用；原文或指示已變動時禁止套用舊提案。編輯引用外的文字會更新位置，改動引用內原文則標示失效並要求重新選取。引用草稿只保留於目前開啟的應用程式，尚未送出的引用不寫入會議；已送出的標記隨會議保存。既有待修訂標記可按「加入訊息框」再確認送出；執行中的引用要求仍排入獨立的一輪。

未完成離線辨識或 Agent 設定時，啟動會停留在佔滿視窗的三步設定導覽，沒有側欄、搜尋或「稍後設定」入口；快捷鍵也無法進入工作區。設定一半後重啟仍停留在導覽；清除已儲存的必要設定也會回到導覽。選用 Codex 時還會檢查 CLI 是否可啟動。導覽自動偵測本機 Codex／Claude Code，支援直接選用偵測到的 CLI 路徑。偵測安裝不代表已登入，Studio 仍使用自己設定的 API key／模型。

設定頁採左右兩欄：左側為語音辨識、Agent 模型、MCP 與 Skills、外觀，右側內容填滿剩餘空間並獨立捲動。設定分類取代專案側欄，左上返回按鈕可回到工作區。底部只有一個與頁面同背景的操作列，可儲存或重新開啟導覽。MCP 範例使用格式化 JSON 並自動換行，窄視窗也不會橫向溢出。

設定導覽與設定頁都有連線測試。語音測試可選指定麥克風、電腦音訊或混合來源；開始後實際說話或播放聲音，顯示即時音量、連線／收音／辨識狀態與回傳文字。支援離線 HTTP 分段、OpenAI 與 vLLM Realtime WebSocket，結束時會送出剩餘 PCM 並等待最後逐字稿。即時會議頁另提供「說話辨識測試」。Agent 測試實際使用選定的 OpenAI、Codex 或 Claude 後端與模型回覆簡短測試文字；連線成功與設定欄位齊全是不同狀態。測試採目前表單的草稿與已儲存的遮罩金鑰，不會自動儲存草稿、建立會議／對話或保留錄音；取消、關閉對話框、重載及退出會釋放資源。ASR 測試最多 90 秒，Agent 測試最多 60 秒；模型與 ASR 測試會使用服務額度。

Agent 執行中只顯示「停止」按鈕；輸入框 Enter 引導目前工作、Ctrl+Enter 排入下一輪，Shift+Enter 換行，閒置時 Enter 送出新工作；steer 未被接受時自動回到佇列。停止會暫停佇列，待執行訊息可逐則移除；JSONL 保存佇列與追加指令，重開後按「繼續佇列」恢復。架構與後端差異見 [Harness 文件](docs/harness.md)。

## 使用流程

1. 建立專案，從「專案工作區」加入一個或多個參考資料夾。
2. 在「設定與接入」填入 ASR 與 Agent 模型設定。
3. 選擇「裝置音量」或「音訊檔案」。裝置下拉選單可選麥克風、系統預設播放音訊或混音；可先測試音量，或勾選「只錄音」。
4. 開始會議，逐字稿會出現在工作台；音訊每秒寫入本機。
5. 結束會議，在 Agent 訊息框輸入 `@` 搜尋並指定文件／資料夾，或加入「交給 Agent 搜尋」關鍵字，再輸入整理要求並送出。
6. 檢查 Agent 提案，套用修訂；可手動編輯、查看歷史版本與匯出 Word。

## 搜尋

點擊搜尋或按 Ctrl+K 開啟置中圓角搜尋面板，不切換目前頁面。空白查詢顯示最近更新的 9 場會議，結果包含標題、所屬專案與 Alt+1–9 快捷鍵；輸入文字可搜尋會議標題、專案名稱、筆記、逐字稿及對話內容，多個詞須同時符合。方向鍵選取、Enter 開啟、Esc 或點擊外部關閉。面板中 Ctrl+N 新增會議、Ctrl+O 編輯專案參考資料夾、Ctrl+P 開啟專案檔案搜尋對話框；切換會議會先保存目前筆記。支援淺色、深色主題與窄視窗。

## 專案管理與音訊裝置

點擊側欄專案會開啟「專案總覽」，顯示此專案的會議數、進行中工作、已撰寫紀錄、參考資料夾數及此專案的全部會議紀錄。總覽內的「即時會議」及「音檔辨識」按鈕保留目前專案；在專案總覽可使用 Ctrl+Alt+M／Ctrl+Alt+I 開啟對應工作台。封存專案的入口停用，解除封存後恢復。

專案側欄提供「⋯」操作選單及編輯捷徑；頂部專案名稱與「專案」下拉選單共用釘選專案／取消釘選專案、編輯、區段、在檔案總管中開啟、封存／解除封存與移除專案操作。區段可新增並選擇既有分組，預設區段會取消分組；釘選的專案集中在側欄「已釘選」區段，不重複出現在一般專案清單；取消釘選回到原有區段。釘選及分組存於專案資料，重啟後保留。封存後暫時離開已釘選清單，解除封存時保留釘選狀態。多個來源資料夾會先顯示資料夾選單；尚未加入資料夾時開啟功能停用。選單支援鍵盤與窄視窗側欄。

「編輯專案」及「加入資料夾」開啟同一個圓角對話框，包含名稱、來源資料夾清單與新增／移除操作。資料夾由原生選擇器選取，可多選並自動去除重複；所有改動在按「儲存」後才一起套用，取消或 Esc 會放棄草稿。移除來源資料夾只取消引用，不會刪除磁碟資料。底部「移除本機專案」開啟刪除確認。編輯介面適用所有主題與窄視窗；儲存前會檢查專案是否遭其他操作更新，變更參考資料夾時須先結束正在執行的工作。

專案工作區提供「編輯專案」、「封存專案／解除封存」、「刪除專案」。封存專案移至 sidebar 的「已封存專案」，保留既有會議與文件；解除封存後可重新建立會議。刪除需要確認，會清除專案的會議、文件版本、JSONL 與應用程式擁有的錄音，以及目前版本各專案隔離的 runtime。引用的工作區資料夾不會被移除。有錄音、辨識或 Agent 工作正在執行時不能封存／刪除。

「裝置音量」與說話辨識測試共用裝置清單。允許麥克風權限後，列出系統／驅動提供的完整名稱與型號，區分實體麥克風、系統預設與通訊預設；同名裝置保留獨立選項。可搜尋型號，長名稱會換行，選取後顯示完整名稱與使用路由；說話測試另外顯示實際收音裝置、取樣率與聲道數。若驅動僅提供「USB Audio Device」等通用名稱，不會推測型號。偵測用的暫時音訊串流會立即釋放，不保留錄音。

選定裝置使用 deviceId exact，同時套用於音量測試與正式錄音，裝置選擇會在本機記憶。裝置插拔後重新偵測；所選麥克風已移除時，在非錄音狀態切回系統預設。系統 loopback 擷取目前預設播放裝置，不將 audiooutput 清單冒充可指定的擷取來源。「音訊檔案」可選擇音檔，再進行會後辨識。

音量測試獨立管理 media tracks 與 AudioContext，關閉時釋放資源；動畫最多約 20 fps，重用取樣陣列，以 transform 更新音柱。系統測試／錄音都使用低解析度、1 fps 的必要影像軌，並停用 desktopCapturer 縮圖處理。

## 下拉選單

所有單選下拉選單共用自訂元件：圓角觸發按鈕、半透明模糊面板、搜尋、選取勾號、可捲動選項與群組標題。支援方向鍵、Home／End、Enter、Escape 與 Tab；停用選項不可選取。選單位於 top layer，避免被工作區圓角或捲動面板裁切，並依視窗空間向上／向下開啟。原有欄位值與 change 事件保持相容。

## 可調整側邊欄

React 外框使用 react-resizable-panels 的 Group、Panel、Separator；側欄可滑鼠／觸控拖曳、鍵盤調整與按鈕收合，展開寬度限制 220–360 px，並在本機記憶。視窗寬度 900 px 以下改為抽屜，選擇導覽項目、點遮罩或按 Escape 可關閉；抽屜開啟時限制焦點於導覽區。切換視窗尺寸不重新建立編輯器，保留正在輸入的筆記。Electron 最小視窗為 480×540。

## ASR

設定導覽與設定頁以「離線辨識（必填）」與「即時辨識（選用）」兩個 Tab 區隔，支援方向鍵／Home／End 切換，切換時保留未儲存欄位。兩者可獨立填寫端點、模型、API key 與 Headers，並各自提供裝置說話測試。離線辨識未完成時無法進入工作區；只設定即時服務也無法通過導覽。即時辨識預設不啟用，未啟用時可留空全部即時欄位，會議收音使用 HTTP 分段辨識；啟用後才要求即時服務必要欄位。音檔匯入與錄音補辨識固定使用離線服務。清除已儲存的離線必要欄位後會重新進入導覽。舊版自訂封包／WebRTC 設定保留相容讀取，新畫面改用標準 API 接入。

### 離線辨識：/audio/transcriptions

支援 OpenAI 與相容的 HTTP multipart 轉錄服務，包括自架 vLLM／Whisper。端點必須填完整 URL（例如 http://localhost:8000/v1/audio/transcriptions），保留自訂路徑與 query，不自動追加路徑。請求包含 file、model、response_format=json 與選填 language，回應需包含 text 字串。預設官方端點與 whisper-1；可自由填模型名稱。本機無驗證服務可留空 API key；官方端點須驗證。Content-Type 與 multipart boundary 由程式產生。

用於會議收音時，每 2／5／10／15 秒產生獨立、可解碼的單聲道 PCM16 WAV 上傳，不將 MediaRecorder 的不完整 WebM 片段當成獨立檔案。串流會略過近乎靜音的分段；採 FIFO、最多四段待處理，辨識跟不上時停止上傳並保留會議錄音。停止時送出剩餘 PCM 與最後不足一段的音訊，最多等待 35 秒；取消會中止 HTTP 請求，不再接收晚到文字。段落時間以音訊取樣數估算，不是字詞級時間戳。這種模式有分段累積及模型處理延遲，沒有逐字增量回傳。

音檔匯入與補辨識使用同一個 HTTP client、獨立離線驗證、模型及語言設定。音檔單檔上限 1 GB（1024 MB），先以隨應用程式提供的 FFmpeg 串流解碼為 16 kHz 單聲道 PCM16，再轉成每段最多 30 秒的獨立 WAV（約 0.96 MB），依序辨識並保留最後不足一段的音訊。在第 25–30 秒尋找至少 200 ms 的低音量停頓，優先從停頓中間切段；找不到時下一段回帶 1 秒，減少字詞跨界造成的漏字。只有實際重疊的相鄰段落會比對前段結尾與後段開頭，去除明確相符的重複文字；短字、不同措辭或不確定內容保留。停頓偵測與文字比對都是啟發式，無法保證完全沒有漏字或重複，時間標記仍為分段估計。記憶體只保留目前分段，不載入整份解碼音訊、不修改原檔；各段逾時 30 分鐘，錯誤或取消會停止後續分段並釋放解碼程序。匯入時長按原始音訊時間計算，不重複累加重疊部分；錄音補辨識依錄音起點加上時間偏移。TXT／SRT／VTT 逐字稿上限 25 MB，維持直接匯入。

音檔前處理依序執行「解碼與轉檔 → 降低背景雜音 → 停頓偵測與分段 → 語音辨識」，前面三個階段全數完成後才開始上傳。匯入頁、即時會議的音檔模式及會議來源面板顯示階段、已處理音訊時間、可計算的階段百分比與辨識段數；未知解碼總長度時顯示不定進度，不假造百分比。進度以節流 IPC 更新，可切頁、編輯與重新載入；重新載入會接回目前工作，可在卡片取消。關閉應用程式會中止 HTTP、停止 FFmpeg、關閉 Worker 並清除暫存。

「辨識前降低背景雜音」預設開啟，也可關閉並在本機記住選擇。使用 70 Hz 高通與溫和的 FFT 降噪（8 dB、追蹤底噪），適合持續背景噪聲；不是說話者分離，也不能保證提升每段錄音的辨識率。降噪保留取樣數與時間長度，原始檔案不會被覆寫。解碼與降噪由單執行緒 FFmpeg 子程序處理，分段掃描在 Node Worker 執行；renderer 只接收小型進度事件，主程序只讀取目前上傳分段及處理非阻塞 HTTP。完整 PCM 存在作業系統的工作暫存目錄，16 kHz PCM16 每分鐘約 1.92 MB，降噪階段峰值約兩份 PCM；成功、失敗與取消都會清理本次工作目錄。

### 即時辨識：/v1/realtime

可自訂完整 ws:// 或 wss:// 端點、模型、API key 與 Headers，選擇 OpenAI 或 vLLM 協定。兩者的 session 與逐字稿事件不同，由 adapter 處理。

OpenAI 使用 transcription session 與 24 kHz PCM16，待 session.updated 後才送音訊；預設模型 gpt-live-transcribe，可依服務權限修改。使用 conversation.item.input_audio_transcription 的增量／完成事件，依本地音量判斷提交音訊。

vLLM 使用 16 kHz PCM16、session.created、含 model 的 session.update，以及 input_audio_buffer.append／commit。解析 transcription.delta／done；結束時傳送 final=true，等待最後文字。vLLM 服務端須部署支援 Realtime 的語音模型。

所有 HTTP／WebSocket API 請求在主程序執行。兩類 API key 及驗證 Headers 分別以 Electron safeStorage 加密保存；畫面回傳遮罩 key。舊版共用 key 會在讀取時補入離線 key，新設定可使用不同憑證。

## Agent、MCP 與 Skills

Agent 採抽象 `HarnessAdapter`，設定頁可選 OpenAI API（預設）、Codex、Claude Code。OpenAI 與 Codex 使用設定的 Responses Base URL、API key 與模型；Codex 另需本機 CLI。Claude 使用獨立的 Anthropic API key 與模型，透過 Claude Agent SDK 執行，可選擇自有 CLI。只有選定的後端會啟動 runtime，未自動切換至其他 provider。

三個後端共用唯讀工具、MCP 確認、skills、取消及文件版本檢查。「設定 → Agent」可分別設定模型回合上限（1–10,000）、工具呼叫上限（0–10,000，0 不限）及每次執行時間（0–1,440 分鐘，0 不限）。時間預設 30 分鐘；舊版工具上限沿用原本 maxSteps，儲存後可獨立調整。OpenAI 模型請求與 Claude turns 使用模型回合上限；Codex 原生回合由後端管理，仍受共同工具及時間上限控制。設定儲存後於下一次執行生效，正在執行的工作使用開始時的設定。工具按需分頁讀取逐字稿，原稿與最近對話隨該次要求提供；Codex／Claude 的原生 session 可續接。詳細分層、能力差異與 Codex source 對照見 [harness 架構](docs/harness.md)。

Agent 助手會顯示本次實際套用的限制、經過時間、工具呼叫數及已取得的逐字稿片段數。同一組參數重複呼叫會標示次數；逐字稿摘要列出 offset、回傳片段數與 nextOffset。每次工具可展開檢視完整傳入參數、output、呼叫 ID、時間與耗時，並複製完整 JSON；畫面只捲動內容，不額外截斷 output。若工具本身回傳截斷標記，明細會如實顯示該標記。內容只在展開時渲染，閱讀上方紀錄時新事件不會強制捲到底部。工具紀錄保存在既有 JSONL，重新開啟會議可恢復最近一次執行的明細；舊版也能顯示已保存的參數與 output，但沒有呼叫 ID 或精確時間的舊資料不會補造。

輸入框輸入 `/` 可選 `/compact`、`/clear`、`/help`，支援方向鍵、Enter／Tab 選取與 Esc 關閉。`/compact` 用目前後端分批摘要對話與工具結果，成功後重設原生 session 並在後續要求帶入摘要；原始聊天、參數與 output 保留。`/clear` 追加重設標記，清空目前對話、提案與 session，保留會議紀錄、逐字稿、音訊及原始 JSONL。兩個操作需先停止工作並移除佇列；清空對話不是刪除磁碟資料。

「設定 → Agent」可切換自動壓縮與字元門檻（預設 60,000，範圍 12,000–1,000,000）。各後端在下一輪開始前整理超過門檻的對話；OpenAI 另在執行中摘要較舊的完整工具回合，保留本次要求、引導訊息及最近一輪完整呼叫／結果。摘要請求計入模型與時間預算，不會佔用最後保留給工作的回合。Codex／Claude 執行中沿用原生壓縮並顯示事件；Studio 的開關不覆蓋 CLI 原生設定。壓縮卡片提供階段、前後字元數、摘要與失敗資訊；失敗或取消時保留原上下文。摘要可能省略細節，仍可用工具重新查閱原始來源。

工作台移除三個重複標題列；儲存按鈕位於編輯／預覽列最右側。預覽、歷史與 Agent 提案中的 `[逐字稿片段ID]` 顯示為來源氣泡，點選可查看會議名稱、時間範圍、講者與完整原文。找不到的 UUID 會明確標示無法取得，不捏造來源；Markdown 原文與匯出仍保留引用 ID。

自動掃描工作區 `.agents/skills/*/SKILL.md`、`.codex/skills/*/SKILL.md` 與 `.claude/skills/*/SKILL.md`，並附帶 `meeting-notes` skill。Skills 可手動指定，也可由 Agent 按需載入。

MCP 支援 stdio 與 Streamable HTTP，設定頁接受 JSON 陣列：

```json
[
  {
    "name": "my-tools",
    "transport": "stdio",
    "command": "node",
    "args": ["C:/tools/server.js"],
    "enabled": true
  }
]
```

每次啟動 MCP 程序／連線與每次工具呼叫都須在 Agent 面板確認。MCP 由共用 transport 連線，映射到各後端的工具介面。MCP 是外部程序，其自身檔案與網路權限不受內建工作區唯讀工具限制。

HTTP MCP 可設定 `headers`（例如 Authorization），stdio 可設定 `env`。ASR headers、ICE credentials 與整份 MCP 設定均使用作業系統憑證加密後儲存。

## 視窗材質

整體使用全寬視窗頂列、單一可收合導覽／專案側欄與右側工作區。右側與底部貼齊外框，逐字稿、編輯器、Agent 和狀態列採相同底色，僅用細線區隔。外框為 12px 圓角，工作區為 16px 圓角與細邊框；Agent 輸入框為 20px 圓角。頂列的匯入、搜尋、外觀及側欄收合按鈕皆可操作。

Windows 導覽區使用 DWM Acrylic（Electron 原生支援 Windows 11 22H2 以上），macOS 使用 under-window vibrancy。外框、sidebar 與視窗頂列共用約 48–52% 染色的原生材質，避免獨立 CSS 模糊層在主面板圓角外產生矩形色差。桌面背景經作業系統模糊後只隱約留下色塊；正文保持實色。原生材質隨主題同步，並尊重系統減少透明度設定。

`node scripts/ui/material-preview.cjs` 在合成的高對比條紋／文字背景前開啟應用，再以桌面 compositor 截圖並裁切至應用範圍。一般 Playwright page screenshot 不包含原生桌面材質，因此請使用 `output/playwright/material-light.png`／`material-dark.png` 檢查效果。

DeepWiki 查詢公開 `openai/codex` 未找到桌面 UI 的材質實作，不能確認 Codex 自身的精確參數：[查詢結果](https://deepwiki.com/search/find-evidence-for-codex-deskto_524191f2-d7dc-4b4c-ae3a-5b262b5ed707)。本應用依 [Electron 原生材質 API](https://www.electronjs.org/docs/latest/api/base-window#winsetbackgroundmaterialmaterial-windows) 實作並驗證。

## 資料與版本

專案、會議、逐字稿與文件版本存於 Electron userData 的 `studio.sqlite`。對話、工具結果、Agent 事件、提案與 session 綁定保存為 `conversations/<meeting-id>.jsonl`，音訊位於 `audio/`。舊版 SQLite 對話會自動遷移，重啟可載入先前對話與提案，未完成執行標記為取消。格式與恢復規則見 [JSONL 說明](docs/conversations.md)。Windows 預設資料目錄通常為 `%APPDATA%/transcribe-studio/`。錄音異常結束後會標示中斷；未完成音訊可能需要修復容器。

工作區根目錄彼此獨立；讀取路徑以 realpath 驗證，拒絕跳出工作區的路徑、`.env`、`.git`、`node_modules`。目前以檔名／文字搜尋取用資料，沒有向量資料庫。Agent 訊息框以 `@` 選擇文件／資料夾，每則最多指定 20 個項目；選單有 220 ms 輸入延遲、背景分頁、取消及直接指定相對路徑。每批最多 20 筆匹配，另提供「交給 Agent 搜尋」關鍵字，不必先在選單找到檔案。指定來源顯示為可移除標籤，送出才交給 Agent，隨排隊／引導與對話原始紀錄保存；已送出訊息保留來源標籤。原「參考檔案」分頁已移除。文字檔以 UTF-8／UTF-16 LE 分段讀取，不設原本的 8 MB 整檔上限；DOCX 仍限制壓縮檔 32 MB、主文件 XML 解壓縮 4 MB，超限會回報錯誤。PDF、舊版 DOC、試算表及其他不支援格式需先轉成文字或 DOCX。

文件使用 Markdown 保存，自動儲存時保留舊版本。Agent 提案綁定文件版本；生成期間若有手動編輯，需重新生成提案。Word 匯出支援三級標題、段落、粗體、項目清單、表格及逐字稿附錄。

## 驗證與限制

自動測試涵蓋 SQLite 持久化／版本衝突、工作區路徑隔離、字幕解析、DOCX、WebSocket 串流、MCP stdio 工具與 Agent function loop／取消。Electron UI 測試使用隔離測試資料目錄及模擬麥克風，驗證專案、編輯、自動儲存、版本歷史、主題、錄音、暫停／繼續、播放、WebSocket PCM、WebRTC signaling／data channel、Agent 修訂提案與衝突，以及 native DOCX 匯出。

實際 OpenAI、自訂 ASR 與使用者 MCP 服務需要自己的端點、憑證與裝置測試。系統音訊功能先以 Windows loopback 實作，未宣稱 macOS／Linux 等同可用。尚未提供單一應用音訊擷取、即時講者分離、ASR 自動重連／無縫補傳或可視化富文字編輯。音檔匯入／補辨識上限 1 GB，逐字稿文字檔上限 25 MB；補辨識以追加方式保留原逐字稿。

檔案遍歷、搜尋、解碼與 DOCX 解析在 Node Worker 執行，主程序僅傳遞有界結果與進度。沒有 500 個檔案、10,000 個項目或 10 層目錄的總掃描上限；每批約最多 2 秒，回傳 nextCursor 繼續原掃描，直到 null 才表示完成。清單與全文搜尋獨立，支援檔名篩選、區分大小寫與已掃描量／錯誤資訊；尚無增量索引，磁碟速度仍影響完整掃描耗時。

## 實作參考

- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex DeepWiki 分析](https://deepwiki.com/search/explain-implementation-with-fi_a78e2a2f-ae21-42b4-8f52-687a2b09e569)

會議工作台使用 react-resizable-panels 分隔會議來源、紀錄編輯器與 Agent 助手。可拖曳兩條完整高度的分隔線調整左右寬度，或聚焦分隔線後使用方向鍵；桌面比例保存在本機，切換頁籤與重啟後保留。窄視窗自動上下排列，恢復桌面寬度後套用先前比例。調整與 RWD 切換保留編輯器及 Agent 輸入框的 DOM，不會因調整尺寸重建輸入內容。

會議清單與工作台提供刪除會議按鈕，確認後移除該會議、文件版本、JSONL 與專屬本機錄音；保留其他會議、專案、共用錄音及外部工作區檔案。有錄音、ASR、辨識或 Agent 工作時不可刪除。

Agent 可呼叫 `studio_search_meetings` 搜尋／列出同專案先前會議，以及 `studio_read_meeting` 分頁讀取紀錄原文；回傳 meetingId、版本、日期與 `[會議:ID:v版本]` 引用。歷史背景與本次決議分開撰寫，工具結果保存在本次對話 JSONL。OpenAI、Codex 與 Claude Code 共用此工具介面；已刪除、其他專案與本次之後建立的會議無法讀取。

側欄只保留專案清單、已釘選／已封存專案與設定；會議建立與音檔辨識從專案總覽的快捷入口開啟。專案頁移除參考資料夾及工作區檔案面板，資料夾仍由編輯專案管理。搜尋面板的搜尋檔案操作開啟獨立對話框，可查詢與預覽授權的參考檔案。

Agent 輸入區採單一圓角卡片，上方保留訊息與引用，下方左側 `＋` 開啟來源選單，右側集中 skill、目前模型及圓形送出／停止按鈕。來源選單浮於卡片上方，以圖示、名稱與次要說明呈現文件、資料夾及已載入的 skills；長清單在選單內捲動。`＋` 可重新開啟游標處既有的 `@`，不重複插入；Esc 關閉後保持關閉，直到繼續輸入、移動游標或再次按 `＋`。選取 skill 只更新本次 skill，不會送出訊息。底列配合輸入區寬度縮排，模型完整名稱可由滑鼠提示查看。

左下角權限選單提供「編修模式」及「唯讀模式」。編修維持產生提案、人工確認後套用的流程；唯讀使用獨立回答 schema，後端不載入外部 MCP 工具，只提供本機搜尋／閱讀工具，不產生可套用提案。原生 CLI 持續停用 shell 與直接檔案寫入。權限隨每則訊息保存，變更權限後的新要求會排入下一輪，不會在既有工作中途提高權限；不同權限或標記範圍的排隊訊息不能改為引導。

同一選單可開啟暫時對話，與原對話分開保存在記憶體。離開工作區、切換會議、關閉／重新載入視窗或關閉暫時對話時停止工作並清除對話、佇列、圖片與原生暫時 runtime；不寫入應用的 SQLite／JSONL 對話歷史及圖片附件目錄。暫時對話不載入外部 MCP，Codex 使用 ephemeral thread，Claude 使用 `--no-session-persistence`。已手動套用的會議紀錄修改仍會保留；模型供應商端的資料保留政策由供應商決定。

`＋` → 圖片、拖放或貼上可加入圖片，送出前有縮圖與移除按鈕。每則最多 8 張、單張原始檔最多 10 MB；接受 PNG／JPEG／WebP／GIF，轉成 PNG、長邊至多 2400 px，單張轉換後最多 4 MB、合計最多 5 MB。圖片以各後端的原生多模態輸入傳遞；需選擇支援圖片的模型。一般對話的圖片存於 `attachments/<meeting-id>/`，JSONL 只存 metadata；圖片 payload 不當成文字參與壓縮。沒有新圖片的後續訊息可沿用最近三則訊息中最後一組附件，最多 8 張。暫時對話圖片只存在記憶體。

排隊訊息集中於輸入卡片上方的 queue 清單，每則預設收合成單行，可展開完整內容、移除或改為引導目前工作。多張圖片在收合列只顯示第一張縮圖與張數；展開與實際模型請求仍包含全部圖片。接受引導後只執行一次；後端拒絕或工作已停止時保留原佇列。

