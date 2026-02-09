# Persistent Auth State Between Tests

Goal: Tests in certain folders (e.g., `restricted/`) automatically load
saved auth state (cookies + localStorage) via Playwright's storageState.
Works for both static and agentic test modes. Supports multiple user types.

## Core Concept

Instead of logging in before each test, inject saved browser state:

```
zentests/
├── auth/                         # Auto-generated state files
│   ├── user.state.json           # Regular user
│   ├── admin.state.json          # Admin user
│   └── premium.state.json        # Premium user
├── auth-tests.md                 # Contains *-save tests
├── user/                         # Auto-loads auth/user.state.json
│   └── dashboard-tests.md
├── admin/                        # Auto-loads auth/admin.state.json
│   └── admin-panel-tests.md
├── premium/                      # Auto-loads auth/premium.state.json
│   └── premium-features-tests.md
└── static-tests/                 # Generated
```

## User-Facing Behavior

1. Test names ending with `-save` trigger state save (name → filename)
   - `user-save` → `auth/user.state.json`
   - `admin-save` → `auth/admin.state.json`
   - `premium-save` → `auth/premium.state.json`
2. Folder names determine which state to load
3. No explicit user configuration needed (sensible defaults)

Example test file:
```markdown
# Auth Tests

## user-save
Login as user USER
When we see the dashboard, login worked

## admin-save
Login as user ADMIN
When we see the admin panel, login worked

## logout-test
Log out of the application
```

Clean syntax: just say "user ADMIN" - credentials auto-resolved from env.

Environment variables (`.env`):
```bash
# User credentials (referenced as "user USER")
ZENTEST_USER_EMAIL=user@example.com
ZENTEST_USER_PASSWORD=userpass123

# Admin credentials (referenced as "user ADMIN")
ZENTEST_ADMIN_EMAIL=admin@example.com
ZENTEST_ADMIN_PASSWORD=adminpass123

# Premium credentials (referenced as "user PREMIUM")
ZENTEST_PREMIUM_EMAIL=premium@example.com
ZENTEST_PREMIUM_PASSWORD=premiumpass123
```

Pattern: `user {NAME}` → looks up `ZENTEST_{NAME}_EMAIL` and `ZENTEST_{NAME}_PASSWORD`

## User Configuration

Define user types in `zentest.config.js`, passwords in `.env`:

```javascript
// zentest.config.js
export default {
  baseUrl: "https://example.com",

  // Define user types (passwords come from env)
  users: {
    USER: {
      email: "user@example.com",
      // password from ZENTEST_USER_PASSWORD
    },
    ADMIN: {
      email: "admin@example.com",
      // password from ZENTEST_ADMIN_PASSWORD
    },
    PREMIUM: {
      email: "premium@example.com",
      // password from ZENTEST_PREMIUM_PASSWORD
    },
  },
}
```

```bash
# .env (gitignored)
ZENTEST_USER_PASSWORD=userpass123
ZENTEST_ADMIN_PASSWORD=adminpass123
ZENTEST_PREMIUM_PASSWORD=premiumpass123
```

## Auto-Generate Login Tests

Once you create ONE login test, zentest can generate the rest:

```bash
# Run the explorer to generate auth tests for all configured users
zentest auth generate
```

### How it works:

1. You write one login test manually:
```markdown
## user-save
Login as user USER
When we see the dashboard, login worked
```

2. Run `zentest auth generate` - the agent:
   - Reads `users` from config
   - Takes `user-save` as template
   - Generates `admin-save`, `premium-save` by interpolation
   - Runs each one to verify it works
   - Saves auth states for all users

3. Result - auto-generated:
```markdown
## user-save
Login as user USER
When we see the dashboard, login worked

## admin-save
Login as user ADMIN
When we see the admin panel, login worked

## premium-save
Login as user PREMIUM
When we see premium features, login worked
```

### Implementation

```typescript
// src/commands/auth.ts

export async function generateAuthTests(options: { template?: string }) {
  const config = await loadConfig(cwd);
  const users = Object.keys(config.users || {});

  if (users.length === 0) {
    console.error("No users defined in zentest.config.js");
    return;
  }

  // Find existing template test (first *-save test found)
  const templateTest = findTemplateTest(zentestsPath);

  if (!templateTest) {
    console.log("No template found. Creating first login test interactively...");
    // Run agentic tester for first user, use result as template
    await createTemplateTest(users[0]);
  }

  // Generate tests for remaining users
  for (const user of users) {
    if (testExists(user)) continue;

    console.log(`Generating login test for ${user}...`);

    // Interpolate template: replace USER with ADMIN, etc.
    const testDescription = interpolateTemplate(templateTest, user);

    // Run agentically to verify it works
    const result = await runAgenticTest(testDescription);

    if (result.success) {
      // Append to auth-tests.md
      appendTest(`${user.toLowerCase()}-save`, testDescription);
      console.log(`✓ Generated ${user.toLowerCase()}-save`);
    }
  }
}
```

### CLI

```bash
zentest auth generate          # Generate login tests for all users
zentest auth generate --user ADMIN  # Generate for specific user
zentest auth refresh           # Re-run all login tests, refresh states
zentest auth list              # Show configured users and state status
```

## Implementation

### Files to Modify

```
src/
├── config/
│   └── loader.ts           # Add: convention types + resolver + user config
├── commands/
│   ├── run.ts              # Modify: context creation + state saving
│   └── auth.ts             # New: zentest auth generate/refresh/list
├── providers/
│   └── systemPrompt.ts     # Modify: inject user credentials into prompt
└── agents/
    └── testBuilder.ts      # Modify: generate storageState loading
```

---

### 1. `src/config/loader.ts` - Add conventions

```typescript
// Add to existing file

export interface FolderConvention {
  storageState?: string;
}

export interface ConventionConfig {
  folders: Record<string, FolderConvention>;
}

const DEFAULT_CONVENTIONS: ConventionConfig = {
  folders: {
    'restricted/': { storageState: 'auth/user.state.json' },
    'user/': { storageState: 'auth/user.state.json' },
    'admin/': { storageState: 'auth/admin.state.json' },
    'premium/': { storageState: 'auth/premium.state.json' },
  },
};

export async function loadConventions(cwd: string): Promise<ConventionConfig> {
  const configPath = path.join(cwd, 'zentest.conventions.js');
  if (fs.existsSync(configPath)) {
    const loaded = await import(configPath);
    return loaded.default || DEFAULT_CONVENTIONS;
  }
  return DEFAULT_CONVENTIONS;
}

export function resolveStorageState(
  testFilePath: string,
  zentestsPath: string,
  conventions: ConventionConfig
): string | undefined {
  const relative = path.relative(zentestsPath, testFilePath);

  for (const [prefix, convention] of Object.entries(conventions.folders)) {
    if (relative.startsWith(prefix) && convention.storageState) {
      const statePath = path.join(zentestsPath, convention.storageState);
      if (fs.existsSync(statePath)) {
        return statePath;
      }
    }
  }
  return undefined;
}
```

---

### 2. `src/config/loader.ts` - User credentials resolver

```typescript
// Add to existing file

export interface UserConfig {
  email: string;
}

export interface UserCredentials {
  email: string;
  password: string;
}

/**
 * Get credentials for a named user
 * - Email from config (zentest.config.js)
 * - Password from env (ZENTEST_{NAME}_PASSWORD)
 */
export function getUserCredentials(
  userName: string,
  config: ZentestConfig
): UserCredentials | null {
  const name = userName.toUpperCase();
  const userConfig = config.users?.[name];

  if (!userConfig) {
    console.warn(`Warning: User "${name}" not defined in zentest.config.js`);
    return null;
  }

  const password = process.env[`ZENTEST_${name}_PASSWORD`];
  if (!password) {
    console.warn(`Warning: Password for "${name}" not found`);
    console.warn(`  Set ZENTEST_${name}_PASSWORD in .env`);
    return null;
  }

  return { email: userConfig.email, password };
}

/**
 * Get all configured users from config
 */
export function getConfiguredUsers(config: ZentestConfig): string[] {
  return Object.keys(config.users || {});
}
```

The AI agent receives these credentials in its context when "user {NAME}" is mentioned.

### How credentials reach the AI

Option A: **Inject into system prompt** (preferred)
```typescript
// In agenticTester.ts or systemPrompt.ts
const users = getConfiguredUsers();
const credentialContext = users.map(name => {
  const creds = getUserCredentials(name);
  return `- user ${name}: email="${creds.email}", password="${creds.password}"`;
}).join('\n');

// Add to system prompt:
// "Available test users:\n" + credentialContext
```

Option B: **Substitute in description**
```typescript
// Replace "user ADMIN" with actual credentials
text.replace(/\buser\s+(\w+)\b/gi, (match, name) => {
  const creds = getUserCredentials(name);
  return creds ? `${creds.email} (password: ${creds.password})` : match;
});
```

Option A keeps test descriptions clean and human-readable.

---

### 3. `src/commands/run.ts` - Load & save state

```typescript
// Add imports
import { loadConventions, resolveStorageState, ConventionConfig } from "../config/loader.js";

// In run() function, after loading config:
const conventions = await loadConventions(cwd);

// Modify runTestFile() signature - pass browser + conventions instead of context
async function runTestFile(
  filePath: string,
  baseUrl: string,
  config: ZentestConfig,
  browser: Browser,              // Changed from context
  conventions: ConventionConfig, // Added
  agenticProvider: ComputerUseProvider,
  options: RunOptions,
  headless: boolean
) {
  const zentestsPath = path.dirname(filePath);

  // Create context WITH storage state if convention matches
  const storageState = resolveStorageState(filePath, zentestsPath, conventions);
  const context = await browser.newContext({
    viewport: config.viewport,
    storageState: storageState,
  });

  if (storageState) {
    logLine(INDENT_LEVELS.step, `${statusLabel("info")} Loaded auth: ${path.basename(storageState)}`);
  }

  // ... existing test running code ...

  // AGENTIC MODE: After each test succeeds, check for -save suffix
  for (const test of testSuite.tests) {
    // ... existing agentic test code ...

    if (result.success) {
      passed++;
      testResults.push({ test, steps: result.steps });

      // NEW: Save state if test name ends with -save
      if (test.name.endsWith('-save')) {
        const stateName = test.name.replace('-save', '');
        const authDir = path.join(zentestsPath, 'auth');
        if (!fs.existsSync(authDir)) {
          fs.mkdirSync(authDir, { recursive: true });
        }
        const statePath = path.join(authDir, `${stateName}.state.json`);
        await page.context().storageState({ path: statePath });
        logLine(INDENT_LEVELS.step, `${statusLabel("check")} Saved auth state: ${statePath}`);
      }
    }
  }

  // STATIC MODE: Pass storage state via env var
  // Modify the call to runStaticTest:
  const ranStatic = await runStaticTest(staticTestPath, baseUrl, headless, storageState);
}

// Modify runStaticTest to accept storageState
async function runStaticTest(
  staticTestPath: string,
  baseUrl: string,
  headless: boolean,
  storageState?: string
): Promise<boolean> {
  // ... existing code ...

  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ZENTEST_BASE_URL: baseUrl,
      ZENTEST_STORAGE_STATE: storageState || "",
    },
  });

  // ... rest unchanged
}
```

---

### 4. `src/agents/testBuilder.ts` - Generate state-aware tests

```typescript
// Modify generateSuite() to include storage state loading at top

generateSuite(testResults: TestResult[], suite: TestSuite): string {
  const lines: string[] = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    ...this.buildConfigLoader(),
    ``,
    `// Load auth state if provided via environment`,
    `if (process.env.ZENTEST_STORAGE_STATE) {`,
    `  test.use({ storageState: process.env.ZENTEST_STORAGE_STATE });`,
    `}`,
    ``,
    `test.describe.serial('${this.escapeString(suite.name)}', () => {`,
    `  let baseUrl;`,
    `  let page;`,
    // ... rest unchanged
  ];

  // ... rest of method unchanged
}
```

---

## Runtime Flow

```
Run 1: zentest run (first time)

  1. auth-tests.md (agentic mode)
     │
     │  System prompt includes:
     │  "Available test users:
     │   - user USER: email=user@example.com, password=userpass123
     │   - user ADMIN: email=admin@example.com, password=adminpass123"
     │
     ├── user-save: "Login as user USER"
     │   ├── AI sees credentials in context
     │   ├── AI logs in with user@example.com
     │   ├── Test passes
     │   └── Saves → auth/user.state.json ✓
     ├── admin-save: "Login as user ADMIN"
     │   ├── AI logs in with admin@example.com
     │   ├── Test passes
     │   └── Saves → auth/admin.state.json ✓
     └── logout-test
         └── AI logs out (states already saved)

  2. user/dashboard-tests.md (agentic mode)
     ├── Detects: user/ folder
     ├── Loads: auth/user.state.json
     └── Tests run already logged in ✓

  3. admin/admin-panel-tests.md (agentic mode)
     ├── Detects: admin/ folder
     ├── Loads: auth/admin.state.json
     └── Tests run already logged in ✓

Run 2: zentest run (subsequent)

  1. auth-tests.md (static mode - fast)
     ├── Replays recorded login steps
     └── Re-saves states (refreshes tokens)

  2. user/dashboard-tests.md (static mode - fast)
     ├── Loads auth/user.state.json
     └── Already logged in ✓

  3. admin/admin-panel-tests.md (static mode - fast)
     ├── Loads auth/admin.state.json
     └── Already logged in ✓
```

---

## Folder Structure After Running

```
zentests/
├── auth/                         # Auto-created
│   ├── user.state.json           # From user-save test
│   ├── admin.state.json          # From admin-save test
│   └── premium.state.json        # From premium-save test
├── auth-tests.md
├── user/                         # Loads auth/user.state.json
│   └── dashboard-tests.md
├── restricted/                   # Alias for user/ (same state)
│   └── settings-tests.md
├── admin/                        # Loads auth/admin.state.json
│   └── admin-panel-tests.md
├── premium/                      # Loads auth/premium.state.json
│   └── premium-features-tests.md
├── static-tests/                 # Generated
│   ├── auth-tests.spec.js
│   ├── user/
│   │   └── dashboard-tests.spec.js
│   ├── admin/
│   │   └── admin-panel-tests.spec.js
│   └── premium/
│       └── premium-features-tests.spec.js
└── runs/                         # Artifacts
```

---

## Default Conventions (Built-in)

No config file needed. These work out of the box:

| Folder | Loads State |
|--------|-------------|
| `user/` | `auth/user.state.json` |
| `restricted/` | `auth/user.state.json` (alias) |
| `admin/` | `auth/admin.state.json` |
| `premium/` | `auth/premium.state.json` |

Custom conventions via `zentest.conventions.js`:
```javascript
export default {
  folders: {
    'user/': { storageState: 'auth/user.state.json' },
    'admin/': { storageState: 'auth/admin.state.json' },
    'premium/': { storageState: 'auth/premium.state.json' },
    'enterprise/': { storageState: 'auth/enterprise.state.json' },
  },
}
```

---

## Acceptance Criteria

### State Management
- [ ] Test name `user-save` saves state to `auth/user.state.json`
- [ ] Test name `admin-save` saves state to `auth/admin.state.json`
- [ ] Tests in `user/` auto-load `auth/user.state.json`
- [ ] Tests in `admin/` auto-load `auth/admin.state.json`
- [ ] Agentic tests start already logged in when state loaded
- [ ] Static tests start already logged in when state loaded
- [ ] `auth/` directory auto-created on first save

### User Configuration
- [ ] Users defined in `zentest.config.js` with email
- [ ] Passwords read from `ZENTEST_{NAME}_PASSWORD` env var
- [ ] "user ADMIN" resolves credentials from config + env
- [ ] Available users listed in AI system prompt
- [ ] Missing user/password shows warning, doesn't crash

### Auth Generation
- [ ] `zentest auth generate` creates login tests for all users
- [ ] Uses first `*-save` test as template
- [ ] Interpolates template for each user type
- [ ] Runs agentically to verify each works
- [ ] `zentest auth refresh` re-runs and updates states
- [ ] `zentest auth list` shows users and state status

---

## Security Notes

- Add to `.gitignore`:
  - `zentests/auth/*.state.json` (session tokens)
  - `.env` (passwords)
- **Safe to commit**: `zentest.config.js` (emails only, no passwords)
- **Never commit**: Passwords - always use `ZENTEST_*_PASSWORD` env vars
- **Test files**: Use "user ADMIN" syntax, not actual credentials
- **CI/CD**: Store passwords + state in secrets, inject at runtime
- Consider encrypting state files at rest for extra security
