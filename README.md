# Zentest—The Agentic QA Team

Zentest is QA end-2-end testing tool that works entirely decoupled from your application.

Tests are defined in your language. And executed without writing any code (yourself). You don't even need access to the codebase of apps you want to test.

<img width="512" height="467" alt="image" src="https://github.com/user-attachments/assets/587f4a38-774a-47be-9b0b-952aa4d1b0ea" />

## How it works

### Your first app test

1. First you create a new app test suite:

- enter website: example.com
- environment: production
+ add environment -> you can add different environments for dev / testing / staging / beta
    - website: dev.example.com
    - environment: dev

2. You write a test in plain English:

    "A user can login to the app with username testuser@example.com and the password password123"

    Notice how you don't have to specify which buttons to click, which page to navigate to, etc.

3. Run tests (in environment)

    The first time tests are run it might take a little bit longer. An agent will explore your page and will try to accomplish their task.

    Consecutive runs will be faster. Unless the layout of your page changes. 


## Under the hood

The following components are part of the Zentest

- **Agentic Tester**: Runs the plain english test
- **Test Builder Agent**: Observes Agentic Tester and builds static Playwright tests.
- **Static E2E Tester**: Runs static Playwright tests.
- **Test Healer**: When static tests fail, it will re-run the `Agentic Tester` for specified test. If Agentic Tester fails, it will try to explain what failed and paste screenshot in the place it fails.

When a user writes a test the following things happen under the hood:

### Agentic Tester and Test Builder Agent

// these could be two agents in Tandem or one agent that does both.

**The Agentic Tester** tries to understand your plain English tests.
It will go to the configured website, and read the source code and take screenshots to determine what it needs to do or where it needs to navigate to accomplish the task. 

Additionally the **Test Builder Agent** agent will try to build out a Playwright test while it observes the actions of the *Agentic Tester*, to accomplish this task super fast when the test needs to run again.

For example:

1. **Agentic Tester** reads instructions:  "A user can login to the app with username testuser@example.com and the password password123" on "example.com"

2. **Agent Tester** navigates to "example.com"

3. Agent loops start:

    a) **Agentic Tester** takes a screenshot of the loaded page (and it can also see what's going on in the browser, e.g. the html structure etc.). The screenshot is fed back to the agent and it uses its own reasoning ability where to go or what to do next.

    b) At the same time the **Test Builder Agent** observes every move / instruction that the Agentic Tester does and tries to translate this into a Playwright test file/function.


Steps 3a and b loop until either the Agentic Tester has accomplished its test task or failed. 

4. a) **Fail Scenario:**
    
    If the Agentic Tester fails, it will collect the screenshots, and its reasoning along the way to explain why it failed.

    The Test Builder doesn't need to do anything it can basically throw away the tests it was inprogress of building.

    b) **Success Scenario:**

    In case the **Agentic Tester** determines it has fulfilled its test successfully it finishes the run with a success message. (✅ in the UI under agentic test)

    The **Test Builder** agent finishes building the Playwright test. And saves it. 
    
    Then the Playwright test is run to determine we were successful in building the test.

    If the Playwright test fails we feed the test and the error back to the agent, and try to make it solve itself and rerun. (Iterate until working, or break out if not successful after X attempts)

    If the Playwright test is successful ✅ in the UI next to static tests.


## Project Structure

### Core Framework

The CLI tool that gets installed/packaged:

```
zentest/
├── src/
│   ├── cli.ts                # CLI entry point
│   ├── agents/
│   │   ├── agenticTester.ts  # AI agent that executes plain English tests
│   │   ├── testBuilder.ts    # Observes and generates Playwright tests
│   │   └── testHealer.ts     # Re-runs agentic tests when static fails
│   ├── runner/
│   │   ├── staticRunner.ts   # Runs Playwright tests
│   │   └── testParser.ts     # Parses .md test files
│   └── utils/
└── package.json
```

### User's Project Structure

When a user runs `zentest` in their project, it looks for a `zentests/` folder:

```
my-app/
├── zentests/
│   ├── auth-tests.md          # Test definitions in plain English
│   ├── navigation-tests.md
│   ├── runs/                  # Auto-generated run artifacts
│   │   └── 2024-01-15-143022/
│   │       └── auth-tests/
│   │           └── login-test/
│   │               ├── screenshot-1.png
│   │               ├── screenshot-2.png
│   │               └── run.log
│   └── static-tests/          # Auto-generated Playwright tests
│       └── auth-tests/
│           └── login-test.spec.ts
└── zentest.config.ts          # App config (URLs, environments)
```

### Test File Format

Tests are written in markdown files. Each heading becomes a test:

```markdown
# Auth Tests

## login-test
A user can login with username test@example.com and password secret123

## logout-test
A logged-in user can logout by clicking the profile menu
```

### Configuration

`zentest.config.ts` defines your app and environments:

```typescript
export default {
  baseUrl: "https://example.com",
  environments: {
    production: { url: "https://example.com" },
    dev: { url: "https://dev.example.com" },
    staging: { url: "https://staging.example.com" }
  }
}
```

### CLI Commands

```bash
zentest init                  # Create initial folder structure
zentest run                   # Run all tests (static first, agentic fallback)
zentest run auth-tests        # Run specific test suite
zentest run --agentic         # Force agentic mode (skip static tests)
zentest run --env=staging     # Run against specific environment
```
