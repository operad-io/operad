/** A stable key for a repository path, for files kept under the operad home. */
export function repositoryPathKey(repositoryPath: string): string {
  return new Bun.CryptoHasher("sha1").update(repositoryPath).digest("hex");
}
