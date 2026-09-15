export interface SkillsAdapter {
  /**
   * Returns skill directories that should be made available to the model.
   * May be async (e.g. to lazily load global skills before enumerating).
   * Disabled skills' paths must NOT be included so the runtime loader
   * never exposes them to the model.
   */
  getSkillPaths(): string[] | Promise<string[]>;
}