# Atok.ai

An intelligent AI companion desktop application for productivity and creativity, built with Tauri, React, and TypeScript.

## 🌟 Features

- **Pure Rust Backend** - Secure and fast Rust/Tauri architecture
  - IPC communication (no HTTP overhead)
  - Argon2 password hashing
  - JWT authentication (7-day tokens)
  - PostgreSQL with sqlx
- **Authentication System** - Complete auth flow
  - Sign In / Sign Up
  - Forgot Password & Reset Password
  - Protected Routes
  - Session Management
- **Task Management** - Organize and track your tasks
- **Extensions** - Extend functionality with plugins
- **AI Search** - Intelligent search capabilities
- **Knowledge Management** - Store and manage your knowledge base
- **Dark Mode** - Full dark mode support
- **Modern UI** - Built with shadcn/ui and Tailwind CSS

## 🏗️ Architecture

```
Frontend (React + TypeScript)
           ↓
    invoke() IPC
           ↓
Backend (Rust/Tauri)
           ↓
    PostgreSQL
```

**Benefits:**

- � **Secure**: No network exposure, IPC-only communication
- ⚡ **Fast**: Native Rust performance, no HTTP overhead
- 🎯 **Type-safe**: Rust's type system prevents runtime errors
- 📦 **Single Binary**: Desktop app with embedded backend

## �🚀 Quick Start

### Prerequisites

- **Node.js** (v18 or higher)
- **pnpm** - `npm install -g pnpm`
- **PostgreSQL** (v14 or higher)
- **Rust** - [Install Rust](https://www.rust-lang.org/tools/install)

### Database Setup

```bash
# Start PostgreSQL
sudo systemctl start postgresql

# Create database
psql -U justrrio -c "CREATE DATABASE atok_ai;"

# Set environment variable (optional)
export DATABASE_URL="postgres://justrrio:dev123@localhost:5432/atok_ai"
```

### Installation

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd atok-ai
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   ```

3. **Configure environment (optional)**

   Create `.env` file in `src-tauri/`:

   ```env
   DATABASE_URL=postgres://justrrio:dev123@localhost:5432/atok_ai
   JWT_SECRET=your-super-secret-key-here
   ```

   Or use defaults (hardcoded in `database.rs` and `auth.rs`).

4. **Run the application**

   ```bash
   # Development mode (with hot reload)
   npm run tauri dev

   # Or using cargo
   cargo tauri dev
   ```

   **First run:** Migrations auto-execute, creating the `users` table.

5. **Build for production**

   ```bash
   npm run tauri build
   ```

   Binary will be in `src-tauri/target/release/`.

## 📖 Documentation

- **[Implementation Summary](IMPLEMENTATION_SUMMARY.md)** - Quick reference guide
- **[Rust Backend Guide](RUST_BACKEND_GUIDE.md)** - Complete Rust/Tauri documentation with learning path

## 🏗️ Tech Stack

### Frontend

- **Tauri 2.x** - Desktop application framework
- **React 19** - UI library
- **TypeScript 5.8** - Type safety
- **React Router 7** - Navigation
- **Tailwind CSS 4** - Styling
- **shadcn/ui** - UI components
- **Framer Motion** - Animations
- **Vite** - Build tool

### Backend (Pure Rust)

- **Tauri** - IPC communication
- **sqlx** - PostgreSQL client
- **Argon2** - Password hashing
- **jsonwebtoken** - JWT authentication
- **Tokio** - Async runtime
- **Serde** - Serialization

## 📁 Project Structure

```
atok-ai/
├── src/                    # Frontend (React + TypeScript)
│   ├── components/         # React components
│   │   ├── auth/          # Auth pages (SignIn, SignUp, etc.)
│   │   └── ui/            # UI components (shadcn/ui)
│   ├── contexts/          # React contexts (AuthContext)
│   ├── services/          # Frontend services (auth.service.ts)
│   └── App.tsx            # Main app component
│
├── src-tauri/             # Backend (Rust)
│   ├── src/
│   │   ├── auth.rs        # Authentication commands
│   │   ├── database.rs    # Database setup & migrations
│   │   ├── models.rs      # Type definitions
│   │   ├── lib.rs         # App entry point
│   │   └── main.rs        # Desktop initialization
│   └── Cargo.toml         # Rust dependencies
│
├── IMPLEMENTATION_SUMMARY.md  # Quick reference
├── RUST_BACKEND_GUIDE.md      # Complete Rust guide
└── README.md                   # This file
```

## 🔐 Authentication

The app includes a complete authentication system:

- **Sign Up** - Register with email and password
- **Sign In** - Login to your account
- **Forgot Password** - Request password reset via email
- **Reset Password** - Set new password with reset token
- **Protected Routes** - Automatic redirect for unauthenticated users
- **Session Persistence** - Stay logged in across app restarts

See [AUTHENTICATION_SETUP.md](AUTHENTICATION_SETUP.md) for detailed setup instructions.

## 🛠️ Development

### Frontend Development

## 💻 Development

### Frontend + Backend

```bash
# Start dev mode (Rust backend + React frontend with hot reload)
npm run tauri dev

# Build for production
npm run tauri build

# Check Rust code
cd src-tauri && cargo check

# Format Rust code
cd src-tauri && cargo fmt
```

### Database Management

```bash
# View database content
psql -U justrrio -d atok_ai

# Query users
psql -U justrrio -d atok_ai -c "SELECT id, email, name, is_verified FROM users;"

# Reset database (WARNING: deletes all data)
psql -U justrrio -d atok_ai -c "DROP TABLE IF EXISTS users;"
# Restart app to run migrations again
```

## 📝 Available Scripts

### Main Commands

- `npm run tauri dev` - Start development mode (Rust + React)
- `npm run tauri build` - Build production app
- `npm run dev` - Start only Vite dev server
- `npm run build` - Build only frontend

### Rust Backend

- `cd src-tauri && cargo check` - Check Rust code
- `cd src-tauri && cargo test` - Run Rust tests
- `cd src-tauri && cargo fmt` - Format Rust code
- `cd src-tauri && cargo clippy` - Lint Rust code

## 🐛 Troubleshooting

### Database Connection Issues

```bash
# Check PostgreSQL status
sudo systemctl status postgresql  # Linux
brew services list                # macOS

# Start PostgreSQL
sudo systemctl start postgresql   # Linux
brew services start postgresql    # macOS

# Verify database exists
psql -U justrrio -l

# Create if missing
createdb -U justrrio atok_ai
```

### Rust Compilation Errors

```bash
# Clean build
cd src-tauri
cargo clean
cargo check

# Update dependencies
cargo update
```

### Frontend Issues

```bash
# Clear cache
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

See [AUTHENTICATION_SETUP.md](AUTHENTICATION_SETUP.md) for more troubleshooting tips.

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

[Your License Here]

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
