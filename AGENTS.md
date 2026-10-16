# 程式碼維護規則

本規則適用於整個專案中人工維護的程式碼、腳本、測試、設定與文件。

- 每個文字來源檔最多 500 行，包含空白行與註解。
- 每個資料夾最多 10 個直接檔案，以及 10 個直接子資料夾。
- 超過行數限制時，依業務責任抽象化並拆分模組，保留清楚的介面與相依方向。
- 超過目錄限制時，依功能或業務邊界分組；必要時重新設計架構。
- 不可藉由壓縮排版、刪除必要註解、任意編號切檔或建立無意義資料夾規避限制。
- 修改既有程式時，同時檢查該檔案與所屬目錄；新建檔案前確認目錄容量。
- `src` 根目錄只保留 `main.ts`，其他實作放在對應業務目錄。
- 禁止使用明示或隱含的 `any` 型別。使用具體資料契約、泛型，或先驗證再縮窄的 `unknown`。
- 不得用 `@ts-ignore`、`@ts-nocheck`、關閉檢查、任意型別斷言或抑制規則規避型別錯誤。
- Biome linter 必須啟用，`noExplicitAny` 為 error；TypeScript 必須開啟 `noImplicitAny` 與 `useUnknownInCatchVariables`。
- 套用 Biome 建議的 style 規則；字串插值使用 template literal，不使用字串串接。保留真正的數值加法。
- 禁止巢狀三元運算（`noNestedTernary: error`）；改用具名函式、`if`／`switch` 或對照表表達條件。
- import（包含 CommonJS require）區塊與後續程式碼之間留一個空白列；ESM import 統一放在檔案開頭。
- 函式宣告、函式型別變數及類別／物件方法，與同層相鄰宣告之間留一個空白列。
- 文件註解與所屬函式保持相鄰；不可在字串、template literal 或註解內容中盲目插入空白列。
- `npm run format` 自動整理間距；`npm run lint`、`npm run check` 與建置都必須通過 style 檢查，不得留下警告。

第三方 `node_modules`、自動產生的依賴 lockfile（如 `package-lock.json`、`pnpm-lock.yaml`）、根目錄的
`dist`、`release`、`output`、`test-results` 與 Git 內部資料不列入上述來源規則。
不得為符合來源限制而手動拆分或修改第三方套件、lockfile、安裝檔或建置產物。

執行 `npm run check` 驗證格式、型別及結構。`npm run build` 也會執行結構檢查。
結構檢查應自動涵蓋新增的來源目錄；有功能或架構變動時，另執行相關測試。
