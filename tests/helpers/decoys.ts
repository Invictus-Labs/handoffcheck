// Production-credential-looking DECOYS, assembled at runtime from fragments so that no scanner (including
// this repository's own secret scan) ever sees a complete credential-shaped literal in a committed file.
// None of these values is a real credential; they only have the shape preflight must reject.
const join = (...parts: string[]): string => parts.join("");

export const DECOYS = {
  awsAccessKey: join("AK", "IA", "QYLPMN5HHHFPZAM2"),
  githubToken: join("gh", "p_", "R4nd0mFakeTokenForQaTests0123456789ab"),
  stripeLiveKey: join("sk", "_live_", "FAKEFAKEFAKEFAKEFAKEFAKE0000"),
  slackBotToken: join("xo", "xb-", "000000000000-000000000000-FAKEFAKEFAKEFAKEFAKEFAKE"),
  privateKeyHeader: join("-----BEGIN ", "RSA PRIVATE", " KEY-----")
} as const;

export type DecoyKind = keyof typeof DECOYS;
export const DECOY_KINDS = Object.keys(DECOYS) as DecoyKind[];
