import type { CouncilEvent, PlanTask, Session, TaskResult } from "../../shared/types.ts";
import type { AdapterRegistry } from "../adapters/registry.ts";
import type { CortexConfig, MemberConfig } from "../config.ts";
import { asString, asStringArray, extractJson } from "../util/json.ts";
import { now } from "../util/ids.ts";
import { reviewPrompt, systemPrompt } from "../orchestrator/prompts.ts";
import { runProcess } from "./runner.ts";
import { WorktreeManager } from "./worktree.ts";

type Emit = (e: Omit<CouncilEvent, "seq" | "at" | "sessionId">) => void;

/** Runs approved tasks: worktree → executor → tests → independent review. */
export class ExecutionService {
  readonly worktrees: WorktreeManager;

  constructor(
    private readonly cfg: CortexConfig,
    private readonly adapters: AdapterRegistry,
  ) {
    this.worktrees = new WorktreeManager(cfg.execution.workspace, cfg.dataDir);
  }

  private member(id: string): MemberConfig | undefined {
    return this.cfg.members.find((m) => m.id === id);
  }

  /** Executor named by the plan if it can execute, else the first member that can. */
  resolveExecutor(requested: string): MemberConfig | undefined {
    const m = this.member(requested);
    if (m?.canExecute && this.adapters.get(m.id).execute) return m;
    return this.cfg.members.find((x) => x.canExecute && this.adapters.get(x.id).execute);
  }

  private resolveReviewer(session: Session, executorId: string): MemberConfig | undefined {
    if (session.reviewer !== executorId) return this.member(session.reviewer);
    return this.cfg.members.find((m) => m.id !== executorId && m.roles.includes("reviewer")) ?? this.cfg.members.find((m) => m.id !== executorId);
  }

  async runTask(session: Session, task: PlanTask, emit: Emit, signal: AbortSignal): Promise<TaskResult> {
    const result: TaskResult = { taskId: task.id, status: "running", output: "", startedAt: now() };
    const executor = this.resolveExecutor(task.executor);
    if (!executor) {
      return { ...result, status: "skipped", output: "No member with canExecute and an executable adapter is configured.", finishedAt: now() };
    }
    emit({ type: "task.started", actor: executor.id, phase: "execution", text: task.title, data: { taskId: task.id } });

    const wt = await this.worktrees.create(session.id, task.id);
    result.branch = wt.branch;
    result.worktree = wt.path;

    const instructions = `${task.title}\n\n${task.instructions}\n\nContext: this task is part of the approved plan "${session.plan?.title ?? session.title}". Work only inside the current directory. Do not push or deploy.`;
    const exec = await this.adapters.get(executor.id).execute!({
      instructions,
      cwd: wt.path,
      taskId: task.id,
      signal,
      onOutput: (chunk) => emit({ type: "task.output", actor: executor.id, phase: "execution", text: chunk, data: { taskId: task.id } }),
    });
    result.output = exec.output;

    const { diffStat, diff } = await this.worktrees.commit(wt.path, `cortex: ${task.title}`);
    result.diffStat = diffStat;

    const test = this.cfg.execution.testCommand;
    if (test.length > 0) {
      emit({ type: "task.output", actor: "system", phase: "verification", text: `$ ${test.join(" ")}\n`, data: { taskId: task.id } });
      const r = await runProcess(test[0]!, test.slice(1), {
        cwd: wt.path,
        signal,
        timeoutMs: this.cfg.execution.timeoutMs,
        allowedCommands: this.cfg.execution.allowedCommands,
      }).catch((err: Error) => ({ exitCode: -1, stdout: "", stderr: err.message, timedOut: false }));
      result.tests = { command: test.join(" "), exitCode: r.timedOut ? null : r.exitCode, output: (r.stdout + r.stderr).slice(-20000) };
    }

    const reviewer = this.resolveReviewer(session, executor.id);
    if (reviewer) {
      const testsPassed = result.tests ? result.tests.exitCode === 0 : null;
      try {
        const res = await this.adapters.get(reviewer.id).complete({
          system: systemPrompt(reviewer),
          prompt: reviewPrompt(session, task, result, diff),
          signal,
          meta: { phase: "verification", memberId: reviewer.id, title: session.title, roles: reviewer.roles, round: session.round, task: session.task, testsPassed },
        });
        const j = extractJson<Record<string, unknown>>(res.text) ?? {};
        const verdict = asString(j.verdict);
        result.review = {
          reviewer: reviewer.id,
          verdict: verdict === "pass" || verdict === "fail" ? verdict : "concerns",
          findings: asStringArray(j.findings).length ? asStringArray(j.findings) : [res.text.slice(0, 500)],
        };
      } catch (err) {
        result.review = { reviewer: reviewer.id, verdict: "concerns", findings: [`Review failed: ${(err as Error).message}`] };
      }
    }

    const execOk = exec.exitCode === 0;
    const testsOk = !result.tests || result.tests.exitCode === 0;
    const reviewOk = result.review?.verdict !== "fail";
    result.status = execOk && testsOk && reviewOk ? "passed" : "failed";
    result.finishedAt = now();
    emit({
      type: "task.finished",
      actor: executor.id,
      phase: "verification",
      text: `${task.title}: ${result.status}${result.review ? ` (review: ${result.review.verdict})` : ""}`,
      data: result,
    });
    return result;
  }
}
