# Betopia Web Builder - Software Requirements Specification

## 1. Introduction
### 1.1 Purpose
This document specifies the requirements for Betopia Web Builder, a desktop AI-assisted web application builder that converts natural-language prompts into working projects.

### 1.2 Scope
Betopia Web Builder is a Tauri 2 desktop application that combines:
- AI chat and plan-build orchestration
- Code editing and file management
- Terminal execution
- Live preview and runtime diagnostics
- Provider, agent, and MCP extensibility

### 1.3 Definitions
- AI chat: The conversational interface used to request work from the model
- Plan-build workflow: A staged flow where the AI proposes a plan before editing files
- Agent: A specialized AI persona such as Coder, Architect, Reviewer, or Security
- MCP: Model Context Protocol, used to connect external tools
- Workspace: The local project being edited in the desktop app

## 2. Overall Description
### 2.1 Product Perspective
The product is a desktop-native AI web-app builder with a thin Rust native layer and a React frontend. The AI engine operates inline in the frontend and uses native commands for file, shell, PTY, secret storage, and preview-server tasks.

### 2.2 Product Functions
- Convert prompts into new projects
- Propose and approve a plan before execution
- Edit files through AI or manual interaction
- Run terminal commands and background processes
- Render and refresh project preview
- Manage agents, providers, snippets, and settings

### 2.3 User Classes
- Builder: Uses the app to create or edit projects
- Reviewer: Reviews AI plans and code changes
- Power user: Configures agents, providers, snippets, and MCP servers

### 2.4 Operating Environment
- Desktop operating systems supported by Tauri 2
- Local filesystem access to user projects
- Optional local Docker sandbox for isolated command execution

### 2.5 Design Constraints
- Local-first desktop architecture
- No mandatory backend service
- AI provider abstraction must support OpenAI-compatible endpoints
- Sensitive credentials must use the OS keychain

## 3. External Interface Requirements
### 3.1 User Interface
The UI shall include:
- Chat panel
- Code editor panel
- File explorer
- Live preview panel
- Terminal panel
- Settings and agent configuration panels
- Publish and permission dialogs

### 3.2 Hardware Interfaces
None required beyond standard desktop input and display devices.

### 3.3 Software Interfaces
- OpenAI-compatible provider APIs
- Betopia AI provider APIs where configured
- MCP servers over stdio, SSE, HTTP, or JSON-RPC
- Local filesystem and shell access via Tauri commands
- OS keychain for secure secret storage

### 3.4 Communication Interfaces
- HTTP streaming to provider endpoints
- IPC between frontend and native shell
- Optional Docker service for sandboxed command execution

## 4. Functional Requirements
### 4.1 AI Prompt-to-Project
- The system shall accept a project description in natural language.
- The system shall generate a full project structure from the prompt.
- The system shall support follow-up modifications to the same project.

### 4.2 Plan-Build Workflow
- The system shall present a build plan for larger tasks.
- The user shall be able to approve or reject the plan before file writes occur.
- The system shall keep the plan visible for review.

### 4.3 Agent Management
- The system shall support built-in agents for coding, architecture, review, and security.
- The system shall support custom agents with configurable name, icon, and instructions.
- The user shall be able to switch agents during work.

### 4.4 Inline Chat and Code Assistance
- The system shall allow code selection and inline AI actions.
- The system shall support explain, refactor, fix, and comment operations.

### 4.5 File and Project Management
- The system shall list the project file tree.
- The system shall support create, delete, rename, and open file actions.
- The system shall support multiple open tabs and dirty state indicators.

### 4.6 Live Preview
- The system shall render a live preview of the project.
- The system shall detect static and runtime server modes where possible.
- The system shall support viewport switching for desktop, tablet, and mobile layouts.
- The system shall capture runtime errors and surface them in logs.

### 4.7 Terminal
- The system shall support multiple terminal tabs.
- The system shall support shell selection where available.
- The system shall retain terminal sessions during the workspace session.

### 4.8 Provider and Model Management
- The system shall support multiple AI providers.
- The system shall allow model selection per provider.
- The system shall store provider credentials securely.

### 4.9 Extensibility
- The system shall support MCP server configuration and usage.
- The system shall support reusable snippets triggered by handles.
- The system shall support custom settings and theme selection.

### 4.10 Publish and Visibility
- The system shall provide a publish action for project output.
- The system shall support visibility controls where applicable.

## 5. Data Requirements
### 5.1 Persistent Data
- Project sessions
- Conversation history
- Code history snapshots
- User settings
- Agent definitions
- Snippets
- Provider configuration

### 5.2 Sensitive Data
- API keys
- Tokens
- Other provider credentials

Sensitive data shall be stored in the OS keychain and not in plain text project files where possible.

## 6. Non-Functional Requirements
### 6.1 Performance
- The application shall remain usable while handling large project trees and generated output.
- Preview refresh should occur quickly after file changes.

### 6.2 Reliability
- App state should persist across restarts.
- Errors in generation, preview, and terminal execution should be visible and recoverable.

### 6.3 Usability
- Core workflows should be available from the main workspace without deep navigation.
- Common actions should be accessible by keyboard shortcuts and contextual controls.

### 6.4 Security
- User approval should gate file writes and deletes when enabled.
- Credentials should be protected by the OS keychain.
- Optional sandboxing should reduce command execution risk.

### 6.5 Maintainability
- UI modules should remain separated by feature area.
- AI engine logic should remain isolated from presentation components.
- Native and frontend responsibilities should stay clearly separated.

## 7. System Features
### 7.1 Chat-to-Build
The system shall translate a user prompt into project scaffolding and implementation steps.

### 7.2 Approval Gate
The system shall request approval before destructive or write operations when configured to do so.

### 7.3 Multi-Agent Workflow
The system shall support task-specific personas that guide generation and review.

### 7.4 In-Editor Productivity
The system shall support inline help, refactoring, and code repair without leaving the editor.

### 7.5 Preview Diagnostics
The system shall display runtime diagnostics and support auto-fix when errors are detected.

### 7.6 Extensibility Layer
The system shall connect external tools through MCP and allow reusable snippet insertion.

## 8. Business Rules
- Large or complex tasks should use plan-first execution.
- Write or delete actions should require confirmation where permission mode is active.
- Project history should be preserved per workspace.
- Provider selection should be user controlled.

## 9. Acceptance Criteria
- A prompt can produce a working project structure.
- A plan can be reviewed before implementation begins.
- A user can edit, preview, and run code inside the same app.
- A user can switch agents and providers without losing workspace context.
- Runtime issues can be observed in logs and addressed through auto-fix where supported.

## 10. Appendices
### 10.1 Relevant Technology Stack
- Tauri 2
- Rust
- React 18
- TypeScript 5
- Vite
- Tailwind CSS 4
- Zustand
- CodeMirror 6
- xterm.js
- MCP
- Optional Docker sandbox

