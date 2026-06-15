# OpenAI Agent 工具目录

> 最后更新: 2026-06-15
> 对齐目标: VS Code Copilot (extensions/copilot/src/extension/tools/)

## 文件结构

```
src/vs/platform/openAIAgent/node/tools/
├── toolNames.ts              ← ToolName 枚举 (对齐 Copilot)
├── toolRegistry.ts           ← 基础类型 + defineTool/createTool 注册
├── registerAllTools.ts       ← 汇总导入所有工具模块
├── readFileTool.ts           ← read_file
├── listDirTool.ts            ← list_dir
├── grepSearchTool.ts         ← grep_search
├── fileSearchTool.ts         ← file_search
├── createFileTool.ts         ← create_file
├── runInTerminalTool.ts      ← run_in_terminal
├── fetchWebPageTool.ts       ← fetch_webpage
├── taskCompleteTool.ts       ← task_complete
├── viewImageTool.ts          ← view_image
├── getErrorsTool.ts          ← get_errors
└── semanticSearchTool.ts     ← semantic_search
```

## 工具一览

### Core 工具（已实现）

| # | 工具名 | LLM 名称 | 文件 | 破坏性 | isDestructive |
|---|--------|---------|------|--------|---------------|
| 1 | 读取文件 | `read_file` | `readFileTool.ts` | 否 | `false` |
| 2 | 列出目录 | `list_dir` | `listDirTool.ts` | 否 | `false` |
| 3 | 文本搜索 | `grep_search` | `grepSearchTool.ts` | 否 | `false` |
| 4 | 文件搜索 | `file_search` | `fileSearchTool.ts` | 否 | `false` |
| 5 | 创建文件 | `create_file` | `createFileTool.ts` | **是** | `true` |
| 6 | 执行命令 | `run_in_terminal` | `runInTerminalTool.ts` | **是** | `true` |
| 7 | 抓取网页 | `fetch_webpage` | `fetchWebPageTool.ts` | 否 | `false` |
| 8 | 任务完成 | `task_complete` | `taskCompleteTool.ts` | 否 | `false` |
| 9 | 查看图片 | `view_image` | `viewImageTool.ts` | 否 | `false` |
| 10 | 获取错误 | `get_errors` | `getErrorsTool.ts` | 否 | `false` |
| 11 | 语义搜索 | `semantic_search` | `semanticSearchTool.ts` | 否 | `false` |

### ToolName 枚举中已定义但未实现（占位）

以下工具名已在 `toolNames.ts` 中定义，但尚未有对应的 `defineTool()` 调用（即未向 LLM 暴露）：

| 工具名 | LLM 名称 | 备注 |
|--------|---------|------|
| `SearchWorkspaceSymbols` | `search_workspace_symbols` | 搜索工作区符号 |
| `GetTerminalOutput` | `get_terminal_output` | 获取终端输出 |
| `GetScmChanges` | `get_changed_files` | 获取 SCM 变更 |
| `Memory` | `memory` | 记忆读写 |
| `SessionStoreSql` | `session_store_sql` | Session 历史查询 |
| `CoreAskQuestions` | `vscode_askQuestions` | 向用户提问 |
| `CoreCreateAndRunTask` | `create_and_run_task` | 创建并运行任务 |
| `CoreRunTest` | `runTests` | 运行测试 |
| `CoreTestFailure` | `testFailure` | 获取测试失败信息 |

---

## 参数 Schema 详情

### 1. `read_file`

```
LLM 名称:   read_file
描述:       Read the contents of a file.
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `filePath` | `string` | ✅ | The absolute path of the file to read. |
| `offset` | `number` | ❌ | 1-based line number to start from. |
| `limit` | `number` | ❌ | Maximum number of lines to read. |

> **对齐 Copilot**: ✅ `readFileV2Description` 使用完全相同的 `offset`/`limit` 命名和描述。

---

### 2. `list_dir`

```
LLM 名称:   list_dir
描述:       List the contents of a directory.
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `path` | `string` | ✅ | The absolute path to the directory. |

> **对齐 Copilot**: ✅ 名称和参数完全一致。

---

### 3. `grep_search`

```
LLM 名称:   grep_search
描述:       Do a fast text search in the workspace.
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `query` | `string` | ✅ | The text or regex pattern to search for. |
| `isRegexp` | `boolean` | ❌ | Whether the pattern is a regex. |
| `includePattern` | `string` | ❌ | Glob pattern to limit search. |
| `maxResults` | `number` | ❌ | Maximum results to return. |
| `includeIgnoredFiles` | `boolean` | ❌ | Include files normally ignored by .gitignore. |

> **对齐 Copilot**: ✅ Copilot 的 `IFindTextInFilesToolParams` 包含完全相同的 5 个参数。Copilot 默认 `isRegexp = true` 时使用正则搜索。

---

### 4. `file_search`

```
LLM 名称:   file_search
描述:       Search for files in the workspace by glob pattern.
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `query` | `string` | ✅ | Glob pattern or file name. |
| `maxResults` | `number` | ❌ | Maximum results to return. |

> **对齐 Copilot**: ✅ Copilot 的 `IFindFilesToolParams` 包含完全相同的 2 个参数。

---

### 5. `create_file`

```
LLM 名称:   create_file
描述:       Create a new file or overwrite an existing one.
破坏性:     ✅ (需要用户确认)
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `filePath` | `string` | ✅ | The absolute path to the file. |
| `content` | `string` ❌ | The full content to write. |

> **对齐 Copilot**: ✅ Copilot 的 `ICreateFileParams` 中 `content` 也是可选的 (`content?: string`)。

---

### 6. `run_in_terminal`

```
LLM 名称:   run_in_terminal
描述:       Execute a command in the terminal.
破坏性:     ✅ (需要用户确认)
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `command` | `string` | ✅ | The command to execute. |
| `description` | `string` | ❌ | Brief description of the command. |
| `timeout` | `number` | ❌ | Optional timeout in milliseconds. |

> **对齐 Copilot**: ✅ Copilot 的 `run_in_terminal` 使用相同的参数名。Copilot 另有 `send_to_terminal`/`kill_terminal`/`get_terminal_output`/`terminal_selection`/`terminal_last_command` 等终端工具（本 agent 尚未实现）。

---

### 7. `fetch_webpage`

```
LLM 名称:   fetch_webpage
描述:       Fetch the content of one or more web pages by URL.
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `urls` | `string[]` | ✅ | The URLs of the web pages to fetch. |
| `query` | `string` | ❌ | Search query to narrow content. |

> **对齐 Copilot**: ✅ Copilot 的 `IFetchWebPageParams` 使用完全相同的 `urls: string[]` + `query?: string`。

---

### 8. `task_complete`

```
LLM 名称:   task_complete
描述:       Signal that the task is fully complete.
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `summary` | `string` | ❌ | Brief summary of what was accomplished. |

> **对齐 Copilot**: ✅ Copilot CLI 的 `TaskCompleteTool` 中 `summary` 也是可选的。

---

### 9. `view_image`

```
LLM 名称:   view_image
描述:       View the contents of an image file.
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `filePath` | `string` | ✅ | The absolute path of the image file. |

> **对齐 Copilot**: ✅ Copilot 的 `ViewImageTool` 使用完全相同的 `{ filePath: string }`。

---

### 10. `get_errors`

```
LLM 名称:   get_errors
描述:       Get compile or lint errors in one or more specific files.
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `filePaths` | `string[]` | ❌ | Absolute paths of files to check. Omit for all errors. |

> **对齐 Copilot**: ✅ Copilot 的 `GetErrorsTool` 使用 `filePaths?: string[]`。空数组返回无错误；省略返回全部。

---

### 11. `semantic_search`

```
LLM 名称:   semantic_search
描述:       Search the codebase using natural language.
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `query` | `string` | ✅ | Natural language query. |

> **对齐 Copilot**: ✅ Copilot 的 `CodebaseTool` 使用完全相同的 `{ query: string }`。

---

## Copilot 工具覆盖度对比

### 已对齐 ✅ (11个)

所有已实现的工具在名称和参数 schema 上均与 Copilot 对齐。

### 缺失（Copilot 有但未实现）

以下 Copilot 工具尚未在 OpenAI agent 中实现：

| Copilot 工具名 | 类别 | 备注 |
|---------------|------|------|
| `apply_patch` | 编辑 | 应用补丁 |
| `replace_string_in_file` | 编辑 | 替换文件中的文本 |
| `multi_replace_string_in_file` | 编辑 | 批量替换 |
| `insert_edit_into_file` | 编辑 | 插入编辑 |
| `create_directory` | 文件 | 创建目录 |
| `send_to_terminal` | 终端 | 向终端发送输入 |
| `kill_terminal` | 终端 | 终止终端 |
| `get_terminal_output` | 终端 | 获取终端输出 |
| `terminal_selection` | 终端 | 获取终端选中 |
| `terminal_last_command` | 终端 | 获取上次命令 |
| `run_task` | 任务 | 运行 VS Code task |
| `get_task_output` | 任务 | 获取 task 输出 |
| `manage_todo_list` | 任务 | 管理 todo 列表 |
| `runSubagent` | 子代理 | 运行子代理 |
| `search_subagent` | 子代理 | 搜索子代理 |
| `vscode_get_confirmation` | UI | 获取用户确认 |
| `vscode_askQuestions` | UI | 向用户提问 |
| `run_vscode_command` | UI | 运行 VS Code 命令 |
| `install_extension` | UI | 安装扩展 |
| `memory` | 记忆 | 记忆读写 |
| `session_store_sql` | 数据 | 查询历史 session |
| `resolve_memory_file_uri` | 数据 | 解析记忆文件 URI |
| `skill` | 技能 | 调用技能 |
| `switch_agent` | Agent | 切换 agent |
| `tool_search` | Agent | 搜索工具 |
| `open_browser_page` | 浏览器 | 打开浏览器页面 |
| `click_element` | 浏览器 | 点击元素 |
| `screenshot_page` | 浏览器 | 截图 |
| `navigate_page` | 浏览器 | 导航 |
| `read_page` | 浏览器 | 读取页面 |
| `hover_element` | 浏览器 | 悬停 |
| `drag_element` | 浏览器 | 拖拽 |
| `type_in_page` | 浏览器 | 输入文本 |
| `handle_dialog` | 浏览器 | 处理对话框 |
| `run_playwright_code` | 浏览器 | 运行 Playwright 代码 |
| `edit_notebook_file` | Notebook | 编辑 notebook cell |
| `run_notebook_cell` | Notebook | 运行 notebook cell |
| `get_notebook_summary` | Notebook | 获取 notebook 摘要 |
| `read_notebook_cell_output` | Notebook | 读取 cell 输出 |
| `github_repo` | GitHub | 搜索 GitHub 仓库 |
| `github_text_search` | GitHub | GitHub 文本搜索 |
| `get_vscode_api` | 文档 | 获取 VS Code API 文档 |
| `read_project_structure` | 项目 | 读取项目结构 |
| `create_new_workspace` | 项目 | 创建新工作区 |
