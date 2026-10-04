# Betopia Web Builder - Product Requirements Document

## 1. Product Overview
Betopia Web Builder is a desktop AI application that helps users generate, edit, preview, and publish web projects from natural-language prompts. It is designed to compress the full build workflow into a single local workspace with AI planning, code generation, terminal access, and live preview.

## 2. Product Goals
- Let users describe an app in natural language and receive a working project
- Support a plan-build review flow before code changes are written
- Give users a single environment for chat, editor, preview, terminal, and file operations
- Support multiple AI providers and specialized agents
- Improve safety through permission dialogs and controlled file actions

## 3. Non-Goals
- Replacing full IDEs for every advanced engineering workflow
- Acting as a hosted multi-tenant SaaS platform
- Providing enterprise source control or CI/CD management beyond project-level workflows

## 4. Target Users
### Primary
- Developers and builders who want to create web apps faster
- Product teams prototyping internal tools or customer-facing experiences

### Secondary
- AI workflow designers
- Power users who want custom agents and provider selection

## 5. User Problems
- Too many tools are needed to go from idea to working app
- AI-generated changes can be risky without approval
- Runtime errors are hard to diagnose when preview and code editing are separated
- Users want flexibility in providers, agents, and external integrations

## 6. Scope
### In Scope
- Prompt-to-project generation
- Plan-build workflow
- Multi-agent support
- Custom agent creation
- Inline chat actions
- Auto-fix for preview runtime errors
- Code editor, explorer, terminal, and live preview
- Publish controls
- MCP server integration
- Settings, snippets, and theme controls

### Out of Scope
- Cloud deployment orchestration as a full platform
- Advanced team collaboration features like live co-editing
- Full enterprise governance, billing, or admin analytics platform

## 7. Core Features
### 7.1 AI Generation
- Users can describe an app in natural language
- The AI can create a full project instead of snippets
- The AI can continue editing the existing project context

### 7.2 Plan-Build Workflow
- Large requests generate a build plan first
- The user reviews and approves the plan before execution
- The system should avoid file writes until approval is granted

### 7.3 Agent System
- Support built-in agents: Coder, Architect, Reviewer, Security
- Support custom agents with name, icon, and instructions
- Allow switching agents based on task type

### 7.4 In-Editor AI
- Inline chat on selected code
- Support explain, refactor, fix, and comment actions
- Auto-fix runtime errors detected in preview

### 7.5 Editor and Workspace
- Multi-tab editing
- Syntax highlighting and autocomplete
- File tree explorer with search and context menus
- File operations: create, rename, delete
- Git status indicators

### 7.6 Preview and Runtime
- Live preview with static and runtime server detection
- Viewport switching for desktop, tablet, and mobile
- Runtime error tracking and logging

### 7.7 Terminal
- Multiple terminal tabs
- Shell selection for PowerShell, Bash, WSL, and related shells

### 7.8 Integrations and Extensibility
- MCP server support
- Multiple AI providers
- Snippets for reusable prompts and context

### 7.9 Project Management
- Create, open, duplicate, and track recent projects
- Persist session history per project
- Save code history and project state

## 8. Functional Requirements
### FR-1 Prompt Handling
The system shall accept natural-language prompts for project creation and modification.

### FR-2 Plan Approval
The system shall generate a build plan for large or complex tasks and require user approval before writing files.

### FR-3 File Operations
The system shall support reading, writing, creating, renaming, and deleting files and folders within the workspace.

### FR-4 AI Agent Control
The system shall allow switching between built-in agents and custom agents.

### FR-5 Code Editing
The system shall provide a code editor with tabs, syntax highlighting, autocomplete, and inline chat.

### FR-6 Preview
The system shall show a live preview of the current project and refresh it when files change.

### FR-7 Terminal
The system shall provide terminal access with multiple tabs and shell selection.

### FR-8 Logging
The system shall capture runtime errors and display logs in the UI.

### FR-9 Provider Selection
The system shall support multiple AI providers and model selection per provider.

### FR-10 Extensibility
The system shall support MCP servers and reusable snippets.

## 9. Non-Functional Requirements
### Performance
- UI interactions should remain responsive during large project operations
- Preview updates should happen with minimal delay after file changes

### Reliability
- Project sessions and settings should persist between launches
- Errors in preview and tool execution should be visible to the user

### Usability
- Core workflows should be accessible from a single workspace
- Common actions should be reachable through shortcuts and context menus

### Security
- API keys should be stored securely in the OS keychain
- File write and delete actions should be gated by approval where configured

### Compatibility
- Desktop app should run through the Tauri-based native shell
- Provider integration should support OpenAI-compatible endpoints

## 10. Constraints
- Local desktop-first architecture
- Rust native layer for filesystem, shell, PTY, and HTTP proxy operations
- Frontend AI engine runs inline without a separate backend service
- Optional Docker sandbox may be used for isolated command execution

## 11. Assumptions
- Users have a compatible desktop environment
- Users may provide their own AI provider credentials
- Projects are stored locally and managed per workspace

## 12. Risks
- Generated code may be incorrect or incomplete without review
- Long-running or destructive commands can affect local files
- Provider or MCP misconfiguration can break AI workflows
- Runtime preview behavior can vary across project types

## 13. Acceptance Criteria
- A user can describe a project and receive a generated project structure
- The user can review and approve an AI-generated plan before code changes
- The editor, terminal, file tree, and preview work together in one workspace
- Runtime errors appear in logs and can be auto-fixed where supported
- Users can switch providers, agents, and project sessions successfully

