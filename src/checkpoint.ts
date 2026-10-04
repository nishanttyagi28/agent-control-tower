import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Checkpoint {
  label: string;
  /** Commit object holding the workspace state (parent: HEAD at checkpoint time). */
  commit: string;
  /** Ref that keeps the commit reachable, e.g. refs/cursor-demo/<run>/review-1. */
  ref: string;
}

export interface WorkspaceCheckpointer {
  checkpoint(label: string): Promise<Checkpoint>;
  /** Workspace-relative unified diff between two checkpoints. */
  diff(from: Checkpoint, to: Checkpoint): Promise<string>;
  /** Make the workspace's working tree match `to`; returns the paths it touched. */
  restore(to: Checkpoint): Promise<string[]>;
}

/**
 * Git checkpoints that never touch the user's history, index or HEAD.
 *
 * Each checkpoint stages the workspace into a throwaway index file (GIT_INDEX_FILE), writes
 * a tree, wraps it in a dangling commit with `commit-tree`, and pins it under
 * `refs/cursor-demo/<run>/<label>`. Branches are untouched and nothing is pushed. Ignored
 * files (.venv, caches) are not captured and are never deleted by restore.
 */
export function gitCheckpointer(workspace: string, namespace: string): WorkspaceCheckpointer {
  const git = (args: string[], env: NodeJS.ProcessEnv = {}) => run(workspace, args, env);

  return {
    async checkpoint(label) {
      const dir = await mkdtemp(join(tmpdir(), "ckpt-"));
      const env = { GIT_INDEX_FILE: join(dir, "index") };
      try {
        await git(["read-tree", "HEAD"], env);
        await git(["add", "-A", "--", "."], env);
        const tree = (await git(["write-tree"], env)).trim();
        const commit = (
          await git(["commit-tree", tree, "-p", "HEAD", "-m", `cursor-demo checkpoint: ${label}`], {
            GIT_AUTHOR_NAME: "cursor-demo",
            GIT_AUTHOR_EMAIL: "cursor-demo@localhost",
            GIT_COMMITTER_NAME: "cursor-demo",
            GIT_COMMITTER_EMAIL: "cursor-demo@localhost",
          })
        ).trim();
        const ref = `${namespace}/${label}`;
        await git(["update-ref", ref, commit]);
        return { label, commit, ref };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async diff(from, to) {
      return git(["diff", "--no-color", "--relative", from.commit, to.commit, "--", "."]);
    },

    async restore(to) {
      const current = await this.checkpoint(`pre-restore-${to.label}`);
      const changes = await git([
        "diff",
        "--no-renames",
        "--relative",
        "--name-status",
        "-z",
        to.commit,
        current.commit,
        "--",
        ".",
      ]);
      const fields = changes.split("\0").filter(Boolean);
      const touched: string[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const status = fields[i] ?? "";
        const path = fields[i + 1] ?? "";
        if (status === "A") {
          await unlink(join(workspace, path)); // created by the agents after the checkpoint
          await removeEmptyParents(join(workspace, path), workspace);
        } else {
          // --worktree only: the user's index is left exactly as it was.
          await git(["restore", `--source=${to.commit}`, "--worktree", "--", path]);
        }
        touched.push(path);
      }
      return touched;
    },
  };
}

async function removeEmptyParents(file: string, stopAt: string): Promise<void> {
  const root = resolve(stopAt);
  for (let dir = dirname(resolve(file)); dir.startsWith(root + "/"); dir = dirname(dir)) {
    if ((await readdir(dir)).length > 0) return;
    await rmdir(dir);
  }
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? done(out) : fail(new Error(`git ${args[0]} failed (${code}): ${err.trim()}`)),
    );
  });
}
