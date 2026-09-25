---
paths:
  - "**/*.rs"
  - "**/Cargo.toml"
---

# Rust — NexOS Language Rules

Applies to all `.rs` files in NexOS projects.

---

## 1. Result<T, E> Over Panics

Never use `unwrap()` or `expect()` in production code. Use `?` for propagation. Reserve `unwrap()` for tests and provably unreachable states (with a comment explaining why).

```rust
// WRONG — panics in production
fn load_config(path: &str) -> Config {
    let content = std::fs::read_to_string(path).unwrap();
    toml::from_str(&content).unwrap()
}

// CORRECT — propagates errors with context
use anyhow::Context;

fn load_config(path: &str) -> anyhow::Result<Config> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read config file: {path}"))?;
    toml::from_str(&content)
        .with_context(|| format!("failed to parse config file: {path}"))
}
```

---

## 2. Library vs Application Errors

- **Libraries**: define typed errors with `thiserror`. Gives callers something to match on.
- **Applications/binaries**: use `anyhow` for flexible, contextual error chains.

```rust
// Library — thiserror for typed, matchable errors
#[derive(Debug, thiserror::Error)]
pub enum UserError {
    #[error("user not found: {id}")]
    NotFound { id: String },

    #[error("duplicate email: {email}")]
    DuplicateEmail { email: String },

    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

// Application — anyhow for ergonomic error chains
use anyhow::{bail, Context, Result};

fn run() -> Result<()> {
    let config = load_config("config.toml")?;
    let pool = connect_db(&config.database_url)
        .context("failed to connect to database")?;

    if !config.feature_enabled {
        bail!("feature is disabled in config");
    }

    Ok(())
}
```

---

## 3. Trait-First Design

Define behavior via traits before implementing structs. This enables testing with mock implementations and supports dependency injection.

```rust
// WRONG — concrete type dependency, untestable
struct UserService {
    db: PostgresPool,
}

// CORRECT — trait-based, testable
#[async_trait::async_trait]
pub trait UserRepository: Send + Sync {
    async fn find_by_id(&self, id: &str) -> Result<Option<User>, UserError>;
    async fn create(&self, input: CreateUserInput) -> Result<User, UserError>;
}

pub struct UserService<R: UserRepository> {
    repo: R,
}

impl<R: UserRepository> UserService<R> {
    pub fn new(repo: R) -> Self {
        Self { repo }
    }

    pub async fn get_user(&self, id: &str) -> Result<Option<User>, UserError> {
        self.repo.find_by_id(id).await
    }
}
```

---

## 4. Ownership — Borrow by Default

Borrow (`&T`) by default. Take ownership only when the function must store or consume the value. Never clone to silence the borrow checker without understanding the root cause.

```rust
// WRONG — takes String when &str suffices
fn word_count(text: String) -> usize {
    text.split_whitespace().count()
}

// WRONG — gratuitous clone
fn process(items: Vec<String>) -> Vec<String> {
    items.clone().iter().map(|s| s.to_uppercase()).collect()
}

// CORRECT — borrow for read-only access
fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}

// CORRECT — accept &[T] instead of &Vec<T> for slices
fn process(items: &[String]) -> Vec<String> {
    items.iter().map(|s| s.to_uppercase()).collect()
}

// CORRECT — Into<String> for constructors that must own
pub fn new(name: impl Into<String>) -> Self {
    Self { name: name.into() }
}
```

---

## 5. Iterators Over Loops

Prefer iterator chains for transformations. Use loops for complex control flow with early returns.

```rust
// CORRECT — declarative transformation
let active_emails: Vec<&str> = users.iter()
    .filter(|u| u.is_active)
    .map(|u| u.email.as_str())
    .collect();

// CORRECT — loop for complex multi-step logic
for user in &users {
    if let Some(verified) = verify_email(&user.email)? {
        send_welcome(&verified).await?;
    }
}

// WRONG — manual index loop where iterator suffices
let mut result = Vec::new();
for i in 0..users.len() {
    if users[i].is_active {
        result.push(users[i].email.as_str());
    }
}
```

---

## 6. Immutability by Default

Use `let` by default. Only `let mut` when mutation is truly required. Prefer returning new values over in-place mutation.

```rust
// WRONG — unnecessary mutation
fn normalize(mut input: String) -> String {
    input = input.to_lowercase();
    input.retain(|c| c.is_alphanumeric() || c == '_');
    input
}

// CORRECT — functional transformation
fn normalize(input: &str) -> String {
    input
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .collect()
}
```

---

## 7. cargo clippy Compliance

`cargo clippy -- -D warnings` must pass with zero warnings before any commit. Warnings are treated as errors.

```bash
# Required before commit
cargo fmt --check          # formatting must be clean
cargo clippy -- -D warnings  # zero warnings
cargo test                 # all tests pass
```

Common clippy lints to watch for:

```rust
// clippy::needless_pass_by_value → prefer &T over T when not consuming
// clippy::clone_on_ref_ptr → use Arc::clone(&x) not x.clone()
// clippy::unwrap_used → no unwrap in non-test code
// clippy::panic → no panic! in library code
// clippy::expect_used → use ? or proper error handling
```

---

## 8. Module Organization

Organize by domain, not by type. Avoid `utils.rs` or `helpers.rs` — put utility functions in the module that owns them.

```
src/
├── main.rs / lib.rs
├── auth/
│   ├── mod.rs          # re-exports public API
│   ├── token.rs        # JWT logic
│   └── middleware.rs   # axum/actix middleware
├── user/
│   ├── mod.rs
│   ├── model.rs        # User struct, UserError
│   ├── service.rs      # UserService<R>
│   └── repository.rs   # UserRepository trait + PostgresUserRepo
└── config.rs           # Settings struct, load_config
```

Visibility rules:
- Default to private
- Use `pub(crate)` for internal sharing across modules
- Only `pub` what belongs to the crate's public API
- Re-export public API from `lib.rs`

---

## 9. Async Runtime

Use `tokio` for async runtimes. Apply `#[tokio::main]` only in `main.rs`. Never block inside async functions — use `tokio::task::spawn_blocking` for CPU-bound work.

```rust
// WRONG — blocking call inside async
async fn process(path: &str) -> anyhow::Result<Data> {
    let content = std::fs::read_to_string(path)?;  // blocks tokio thread
    parse(&content)
}

// CORRECT — offload blocking I/O
async fn process(path: String) -> anyhow::Result<Data> {
    let content = tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&path)
    })
    .await??;
    parse(&content)
}
```

---

## 10. Quality Gates

```bash
cargo fmt --check              # formatting — zero diffs
cargo clippy -- -D warnings    # linting — zero warnings
cargo test                     # all tests pass
cargo build --release          # compiles cleanly
```
