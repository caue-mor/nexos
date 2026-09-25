---
paths:
  - "**/*.go"
  - "**/go.mod"
  - "**/go.sum"
---

# Go — NexOS Language Rules

Applies to all `.go`, `go.mod`, and `go.sum` files in NexOS projects.

---

## 1. Error Wrapping with %w

Always wrap errors with context using `fmt.Errorf` and the `%w` verb. This preserves the error chain for `errors.Is` and `errors.As`.

```go
// WRONG — no context, error chain broken
if err != nil {
    return err
}

// WRONG — fmt.Errorf without %w breaks unwrapping
if err != nil {
    return fmt.Errorf("failed to create user: %s", err)
}

// CORRECT — %w wraps and preserves the chain
if err != nil {
    return fmt.Errorf("userService.Create(id=%s): %w", userID, err)
}
```

For sentinel errors, define them at package level:

```go
var (
    ErrUserNotFound   = errors.New("user not found")
    ErrDuplicateEmail = errors.New("email already exists")
)

// Wrap with context when propagating:
if errors.Is(err, sql.ErrNoRows) {
    return nil, fmt.Errorf("findUser(id=%s): %w", id, ErrUserNotFound)
}
```

---

## 2. Interface-First Design

Accept interfaces, return concrete types. Define interfaces where they are consumed, not where they are implemented. Keep interfaces small (1-3 methods).

```go
// WRONG — accepting concrete type, hard to test
type UserService struct {
    db *PostgresDB
}

// CORRECT — interface defined at consumption site
type UserRepository interface {
    FindByID(ctx context.Context, id string) (*User, error)
    Create(ctx context.Context, user *User) error
}

type UserService struct {
    repo   UserRepository
    logger Logger
}

func NewUserService(repo UserRepository, logger Logger) *UserService {
    return &UserService{repo: repo, logger: logger}
}
```

---

## 3. Context Propagation

Pass `context.Context` as the first parameter of every function that does I/O. Never store context in a struct.

```go
// WRONG — no context, cannot cancel or add deadlines
func (s *UserService) GetUser(id string) (*User, error) {
    return s.repo.FindByID(id)
}

// WRONG — context stored in struct
type Service struct {
    ctx context.Context
}

// CORRECT — context as first parameter
func (s *UserService) GetUser(ctx context.Context, id string) (*User, error) {
    return s.repo.FindByID(ctx, id)
}
```

Always propagate context-aware timeouts at boundaries:

```go
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    user, err := h.service.GetUser(ctx, r.PathValue("id"))
    // ...
}
```

---

## 4. Table-Driven Tests

Use table-driven tests for all non-trivial functions. This makes adding cases cheap and documents expected behavior explicitly.

```go
func TestUserService_GetUser(t *testing.T) {
    tests := []struct {
        name    string
        userID  string
        mock    func(*MockUserRepository)
        want    *User
        wantErr error
    }{
        {
            name:   "returns user when found",
            userID: "user-123",
            mock: func(m *MockUserRepository) {
                m.EXPECT().FindByID(gomock.Any(), "user-123").
                    Return(&User{ID: "user-123", Name: "Alice"}, nil)
            },
            want: &User{ID: "user-123", Name: "Alice"},
        },
        {
            name:   "returns ErrUserNotFound when missing",
            userID: "nonexistent",
            mock: func(m *MockUserRepository) {
                m.EXPECT().FindByID(gomock.Any(), "nonexistent").
                    Return(nil, ErrUserNotFound)
            },
            wantErr: ErrUserNotFound,
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            ctrl := gomock.NewController(t)
            repo := NewMockUserRepository(ctrl)
            tc.mock(repo)

            svc := NewUserService(repo, slog.Default())
            got, err := svc.GetUser(context.Background(), tc.userID)

            if !errors.Is(err, tc.wantErr) {
                t.Fatalf("error = %v, want %v", err, tc.wantErr)
            }
            if diff := cmp.Diff(tc.want, got); diff != "" {
                t.Errorf("mismatch (-want +got):\n%s", diff)
            }
        })
    }
}
```

---

## 5. Functional Options for Constructors

Use functional options for structs with optional configuration. Avoids boolean parameter explosion and is backward-compatible.

```go
type ServerOption func(*Server)

func WithPort(port int) ServerOption {
    return func(s *Server) { s.port = port }
}

func WithTimeout(d time.Duration) ServerOption {
    return func(s *Server) { s.timeout = d }
}

func NewServer(opts ...ServerOption) *Server {
    s := &Server{
        port:    8080,
        timeout: 30 * time.Second,
    }
    for _, opt := range opts {
        opt(s)
    }
    return s
}
```

---

## 6. Formatting and Tooling

These tools are mandatory — no exceptions:

```bash
gofmt -l .                          # formatting — must produce no output
goimports -l .                      # import grouping
go vet ./...                        # static analysis
staticcheck ./...                   # advanced linting
golangci-lint run                   # aggregated linting
```

`golangci-lint` config (`.golangci.yml`) minimum:

```yaml
linters:
  enable:
    - errcheck
    - govet
    - staticcheck
    - gosimple
    - ineffassign
    - unused
    - wrapcheck     # ensures errors are wrapped with %w
```

---

## 7. Package Organization

Organize by domain, not by layer. Avoid `util`, `common`, `helpers` packages.

```
internal/
├── user/           # domain: all user logic
│   ├── model.go    # types, constants
│   ├── service.go  # business logic
│   ├── repo.go     # repository interface
│   └── handler.go  # HTTP handlers
├── auth/           # domain: auth logic
│   ├── model.go
│   ├── jwt.go
│   └── middleware.go
└── platform/       # infrastructure (DB, HTTP client, logger)
    ├── postgres/
    └── httputil/
```

---

## 8. Logging

Use `log/slog` (stdlib, Go 1.21+). Pass logger via constructor injection, never global state.

```go
// WRONG — global logger, unstructured
log.Printf("user created: %s", userID)

// CORRECT — structured, contextual
func (s *UserService) Create(ctx context.Context, input CreateUserInput) (*User, error) {
    user, err := s.repo.Create(ctx, input)
    if err != nil {
        s.logger.ErrorContext(ctx, "failed to create user",
            slog.String("email", input.Email),
            slog.Any("error", err),
        )
        return nil, fmt.Errorf("Create(%s): %w", input.Email, err)
    }

    s.logger.InfoContext(ctx, "user created", slog.String("id", user.ID))
    return user, nil
}
```

---

## 9. Quality Gates

```bash
go build ./...                  # compiles cleanly
go test ./... -race             # all tests pass, no data races
golangci-lint run               # zero lint issues
go vet ./...                    # zero vet issues
```
