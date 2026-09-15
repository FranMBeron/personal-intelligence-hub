# Contributing

## Local workflow

1. Use Node.js 22 and pnpm 9.15.9.
2. Create a focused branch or isolated worktree.
3. Install dependencies with `pnpm install`.
4. Write a failing test before application behavior, then implement the minimum
   change that makes it pass.
5. Run `pnpm verify` and any affected integration/build checks.
6. Review the diff for credentials, personal content, and deployment-specific
   values before committing.

Keep framework and persistence details behind explicit ports. Changes to shared
contracts require compatibility review before parallel implementation resumes.

By submitting a contribution, you agree that it is licensed under Apache 2.0.
Do not submit content or data that you do not have the right to publish.
