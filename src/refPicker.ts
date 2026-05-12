import * as vscode from 'vscode';

// Minimal subset of the vscode.git repository surface used by the picker.
export interface PickerRepository {
    readonly state: {
        readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
        readonly refs: PickerRef[];
    };
    log(options?: { maxEntries?: number }): Promise<PickerCommit[]>;
}

export interface PickerCommit {
    hash: string;
    message: string;
}

export interface PickerRef {
    // vscode.git RefType: 0=Head, 1=RemoteHead, 2=Tag.
    type: number;
    name?: string;
    commit?: string;
}

export type RefPickItem =
    | { kind: 'separator'; label: string }
    | { kind: 'ref'; label: string; description?: string; ref: string; isCurrent?: boolean }
    | { kind: 'custom'; label: string; description?: string };

export interface BuildInput {
    commits: PickerCommit[];
    refs: PickerRef[];
    headBranchName?: string;
}

export const MAX_RELATIVE = 10;

export function buildRefItems(input: BuildInput): RefPickItem[] {
    const items: RefPickItem[] = [];

    if (input.commits.length > 0) {
        items.push({ kind: 'separator', label: 'Relative to HEAD' });
        const upper = Math.min(input.commits.length, MAX_RELATIVE);
        for (let i = 0; i < upper; i++) {
            const c = input.commits[i];
            const subject = firstLine(c.message);
            const short = c.hash.slice(0, 7);
            const ref = i === 0 ? 'HEAD' : `HEAD~${i}`;
            items.push({ kind: 'ref', label: ref, description: `${subject} (${short})`, ref });
        }
    }

    const locals = input.refs.filter((r) => r.type === 0 && r.name);
    const remotes = input.refs.filter((r) => r.type === 1 && r.name);
    if (locals.length + remotes.length > 0) {
        items.push({ kind: 'separator', label: 'Branches' });
        for (const b of locals) {
            const name = b.name as string;
            const isCurrent = input.headBranchName !== undefined && name === input.headBranchName;
            const item: RefPickItem = { kind: 'ref', label: name, ref: name };
            if (isCurrent) {
                item.description = 'current';
                item.isCurrent = true;
            }
            items.push(item);
        }
        for (const r of remotes) {
            const name = r.name as string;
            items.push({ kind: 'ref', label: name, ref: name });
        }
    }

    const tags = input.refs.filter((r) => r.type === 2 && r.name);
    if (tags.length > 0) {
        items.push({ kind: 'separator', label: 'Tags' });
        for (const t of tags) {
            items.push({ kind: 'ref', label: t.name as string, ref: t.name as string });
        }
    }

    items.push({ kind: 'separator', label: 'Other' });
    items.push({ kind: 'custom', label: 'Custom…', description: 'Type any ref or commit SHA' });

    return items;
}

export function findActiveIndex(items: RefPickItem[], defaultRef: string): number {
    return items.findIndex((it) => it.kind === 'ref' && it.ref === defaultRef);
}

function firstLine(s: string): string {
    const nl = s.indexOf('\n');
    return nl >= 0 ? s.slice(0, nl) : s;
}

interface QuickPickRow extends vscode.QuickPickItem {
    __ref?: string;
    __isCustom?: boolean;
}

export async function pickBaseRef(repo: PickerRepository, defaultRef: string): Promise<string | undefined> {
    let commits: PickerCommit[] = [];
    try {
        commits = await repo.log({ maxEntries: MAX_RELATIVE });
    } catch {
        // Fresh repos with no commits can throw; fall through with an empty list.
    }

    const items = buildRefItems({
        commits,
        refs: repo.state.refs,
        headBranchName: repo.state.HEAD?.name,
    });

    const rows: QuickPickRow[] = items.map((it) => {
        if (it.kind === 'separator') {
            return { label: it.label, kind: vscode.QuickPickItemKind.Separator };
        }
        if (it.kind === 'custom') {
            return { label: it.label, description: it.description, __isCustom: true };
        }
        return { label: it.label, description: it.description, __ref: it.ref };
    });

    const picked = await new Promise<QuickPickRow | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<QuickPickRow>();
        qp.items = rows;
        qp.placeholder = `Pick base ref (default: ${defaultRef})`;
        qp.matchOnDescription = true;
        const activeIdx = findActiveIndex(items, defaultRef);
        if (activeIdx >= 0) qp.activeItems = [rows[activeIdx]];
        qp.onDidAccept(() => {
            const sel = qp.selectedItems[0];
            qp.hide();
            resolve(sel);
        });
        qp.onDidHide(() => {
            qp.dispose();
            resolve(undefined);
        });
        qp.show();
    });

    if (!picked) return undefined;
    if (picked.__isCustom) {
        const typed = await vscode.window.showInputBox({
            prompt: 'Base ref',
            value: defaultRef,
            placeHolder: 'Branch, tag, or commit SHA',
        });
        return typed?.trim() ? typed.trim() : undefined;
    }
    return picked.__ref;
}
