declare module 'https://esm.sh/buffer@6.0.3' {
  export const Buffer: unknown;
}

declare module 'https://esm.sh/@isomorphic-git/lightning-fs' {
  const LightningFS: new (name: string) => { promises: any };
  export default LightningFS;
}

declare module 'https://esm.sh/isomorphic-git' {
  type WalkerEntry = {
    type: function(): Promise<'tree'|'blob'|'special'|'commit'>;
    mode: function(): Promise<number>;
    oid: function(): Promise<string>;
    content: function(): Promise<Uint8Array|void>;
    stat: function(): Promise<Stat>;
  }
  type GitFn = (options?: Record<string, unknown>) => Promise<string>;
  const git: {
    [x: string]: GitFn;
    resolveRef: (options?: Record<string, unknown>) => Promise<string>;
    walk: (options?: Record<string, unknown> & {
      map: (filename: string, entries: Array<(WalkerEntry|null)>) => Promise<any>
    }) => Promise<any>;
    log: (options?: Record<string, unknown>) => Promise<{ oid: string; commit: { parent: string | null; author: { timestamp: number } } | null }[]>;
    status: (options?: Record<string, unknown> & { filepath: string }) => Promise<string>;
    readBlob: (options?: Record<string, unknown>) => Promise<{ oid: string; blob: BufferSource }>;
    statusMatrix: (options?: Record<string, unknown>) => Promise<[string, 0|1, 0|1|2, 0|1|2|3][]>;
    Errors: {
      MergeConflictError: ErrorConstructor;
      PushRejectedError: ErrorConstructor;
      UnmergedPathsError: ErrorConstructor;
    };
  };
  export = git;
}

declare module 'https://esm.sh/isomorphic-git/http/web' {
  const http: unknown;
  export default http;
}

declare module 'https://esm.sh/@toast-ui/editor@3.2.2' {
  export class Editor {
    constructor(options: Record<string, unknown>);
    getMarkdown(): string;
    setMarkdown(markdown: string): void;
    destroy(): void;
  }
}
