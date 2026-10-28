// @wc-ignore-file
export function makeBuild(
  appUrl: string | URL,
): (options?: {
  outfile?: string;
}) => Promise<{ text: string; bytes: number; sha256: string }>;
export function runCli(
  build: (options?: { outfile?: string }) => Promise<{
    text: string;
    bytes: number;
    sha256: string;
  }>,
  selfUrl: string | URL,
  defaultOutfile: string,
): Promise<void>;
