import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runProcess, type RunResult } from "./runner.ts";

const GIT_IDENTITY = ["-c", "user.name=Cortex Council", "-c", "user.email=council@localhost"];

/**
 * Creates one git worktree + branch per approved task, so executors never
 * touch the main checkout and every change is reviewable as a branch.
 */
export class WorktreeManager {
  readonly repo: string;

  constructor(
    workspace: string | null,
    private readonly dataDir: string,
  ) {
    this.repo = resolve(workspace ?? join(dataDir, "sandbox"));
  }

  private git(args: string[], cwd = this.repo): Promise<RunResult> {
    return runProcess("git", [...GIT_IDENTITY, ...args], { cwd, timeoutMs: 60_000, allowedCommands: ["git"] });
  }

  private async gitOk(args: string[], cwd = this.repo): Promise<string> {
    const r = await this.git(args, cwd);
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  }

  /** Ensure the workspace is a git repo with at least one commit (creates the sandbox repo if needed). */
  async ensureRepo(): Promise<void> {
    if (!existsSync(this.repo)) mkdirSync(this.repo, { recursive: true });
    const inside = await this.git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode !== 0) {
      await this.gitOk(["init", "-q", "-b", "main"]);
      writeFileSync(join(this.repo, "README.md"), "# Cortex Council sandbox\n\nApproved tasks run here when no workspace is configured.\n");
      await this.gitOk(["add", "-A"]);
      await this.gitOk(["commit", "-q", "-m", "sandbox: initial commit"]);
    } else {
      const head = await this.git(["rev-parse", "HEAD"]);
      if (head.exitCode !== 0) await this.gitOk(["commit", "-q", "--allow-empty", "-m", "cortex: initial commit"]);
    }
  }

  async create(sessionId: string, taskId: string): Promise<{ path: string; branch: string }> {
    const safeTask = taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const branch = `cortex/${sessionId}/${safeTask}`;
    const path = resolve(this.dataDir, "worktrees", sessionId, safeTask);
    mkdirSync(resolve(this.dataDir, "worktrees", sessionId), { recursive: true });
    await this.gitOk(["worktree", "add", "-q", "-b", branch, path, "HEAD"]);
    return { path, branch };
  }

  /** Commit whatever the executor changed; returns diff stat and patch (empty when nothing changed). */
  async commit(path: string, message: string): Promise<{ diffStat: string; diff: string }> {
    await this.gitOk(["add", "-A"], path);
    const status = await this.gitOk(["status", "--porcelain"], path);
    if (!status.trim()) return { diffStat: "no changes", diff: "" };
    await this.gitOk(["commit", "-q", "-m", message], path);
    const diffStat = (await this.gitOk(["diff", "--stat", "HEAD~1", "HEAD"], path)).trim();
    const diff = await this.gitOk(["diff", "HEAD~1", "HEAD"], path);
    return { diffStat, diff };
  }
}
