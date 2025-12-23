declare module 'https://esm.sh/buffer@6.0.3' {
  export const Buffer: unknown;
}

declare module 'https://esm.sh/@isomorphic-git/lightning-fs' {
  const LightningFS: new (name: string) => { promises: any };
  export default LightningFS;
}

declare module 'https://esm.sh/isomorphic-git@beta' {
  type GitFn = (options?: Record<string, unknown>) => Promise<unknown>;
  const git: {
    [x: string]: GitFn;
    log: (options?: Record<string, unknown>) => Promise<{ oid: string; commit: { parent: string | null; author: { timestamp: number } } | null }[]>;
    readBlob: (options?: Record<string, unknown>) => Promise<{ oid: string; blob: BufferSource }>;
  };
  export = git;
}

declare module 'https://esm.sh/isomorphic-git@beta/http/web' {
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
