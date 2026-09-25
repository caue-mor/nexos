---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/tsconfig.json"
---

# TypeScript — NexOS Language Rules

Applies to all `.ts` and `.tsx` files in NexOS projects.
Enforces NexOS Constitution Articles V (Absolute Imports) and VI (Zero Any).

---

## 1. Strict Mode — Non-Negotiable

`tsconfig.json` must have `"strict": true`. No exceptions.

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

---

## 2. Zero Any

Never use `any`. Use `unknown` and narrow it with type guards.

```typescript
// WRONG
function parsePayload(data: any) {
  return data.userId
}

// CORRECT
function parsePayload(data: unknown): string {
  if (
    typeof data === 'object' &&
    data !== null &&
    'userId' in data &&
    typeof (data as Record<string, unknown>).userId === 'string'
  ) {
    return (data as { userId: string }).userId
  }
  throw new Error('Invalid payload shape')
}
```

---

## 3. Absolute Imports with @/ Alias

Always use `@/` aliases. Never use relative paths that traverse directories.

```typescript
// CORRECT
import { Button } from '@/components/ui/button'
import { useUser } from '@/hooks/use-user'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/types/user'

// WRONG — never do this
import { Button } from '../../../components/ui/button'
import { useUser } from '../../hooks/use-user'
```

---

## 4. Zod Validation at Every Boundary

All data crossing a trust boundary (API responses, form inputs, env vars) must be validated with Zod. Types are inferred from the schema — never declare them separately.

```typescript
import { z } from 'zod'

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.enum(['admin', 'user', 'manager']),
})

type CreateUserInput = z.infer<typeof createUserSchema>

// In a server action or API route:
const validated = createUserSchema.safeParse(formData)
if (!validated.success) {
  return { error: validated.error.flatten() }
}
```

---

## 5. Async/Await Error Handling

Always catch async errors explicitly. Log with context prefix. Re-throw with clear message.

```typescript
async function fetchUserById(userId: string): Promise<UserProfile> {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single()

    if (error) throw error
    return data
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[fetchUserById] Failed for userId=${userId}: ${message}`)
    throw new Error(`Failed to fetch user: ${message}`)
  }
}
```

---

## 6. Interfaces vs Type Aliases

- Use `interface` for object shapes (extendable, implementable)
- Use `type` for unions, intersections, mapped types, and utility types
- Use string literal unions instead of `enum`

```typescript
// Object shapes → interface
interface UserProfile {
  id: string
  name: string
  email: string
  createdAt: Date
}

// Unions, utilities → type
type UserRole = 'admin' | 'user' | 'manager'
type UserWithRole = UserProfile & { role: UserRole }
type PartialUser = Partial<Pick<UserProfile, 'name' | 'email'>>
```

---

## 7. React Patterns

### Component Props

```typescript
// Named interface, never React.FC
interface UserCardProps {
  user: UserProfile
  onSelect: (id: string) => void
  className?: string
}

function UserCard({ user, onSelect, className }: UserCardProps) {
  return (
    <button className={className} onClick={() => onSelect(user.id)}>
      {user.name}
    </button>
  )
}
```

### Server vs Client Components

```typescript
// Server Component (no 'use client') — uses server-side SDK
import { createClient } from '@/lib/supabase/server'

// Client Component ('use client') — uses browser-side SDK
'use client'
import { createClient } from '@/lib/supabase/client'

// NEVER import server SDK in a Client Component
// NEVER expose service_role key anywhere client-accessible
```

### Custom Hooks

```typescript
// Hooks live in src/hooks/, named use*.ts
// Always return a typed object, never a plain array for >2 values

function useUserProfile(userId: string) {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  // ...fetch logic

  return { profile, isLoading, error }
}
```

---

## 8. Naming Conventions

| Entity | Convention | Example |
|--------|-----------|---------|
| Components | PascalCase | `UserProfile.tsx` |
| Hooks | `use` + PascalCase | `useUserProfile.ts` |
| Files | kebab-case | `user-profile.tsx` |
| Constants | SCREAMING_SNAKE | `MAX_RETRY_COUNT` |
| Interfaces | PascalCase | `UserProfileProps` |
| Server Actions | camelCase | `createProject` |
| API Routes | kebab-case | `/api/user-profile` |
| Env Vars | SCREAMING_SNAKE | `NEXT_PUBLIC_API_URL` |

---

## 9. Quality Gates

Before any commit touching `.ts` / `.tsx` files:

```bash
npm run lint       # ESLint — zero errors
npm run typecheck  # tsc --noEmit — zero errors
npm test           # Vitest — all passing
npm run build      # Next.js build — clean
```
