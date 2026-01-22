import 'obsidian';

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}

declare module 'obsidian' {
  export class SecretStorage {
    getSecret(id: string): string | null;
    setSecret(id: string, secret: string): void;
    listSecrets(): string[];
  }

  interface App {
    secretStorage?: SecretStorage;
  }
}
