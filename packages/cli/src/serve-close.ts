/** What a serve context ends with: the views, the plugin store and the log. */
export interface ServeContextEnd {
  readonly views: { drain(): Promise<void>; close(): void | Promise<void> };
  readonly registry: { readonly store: unknown };
  readonly log: { close(): void | Promise<void> };
}

/**
 * Ends a serve context. Work of the context that still reads the stores (a
 * standing hook, a resolve) is waited for, bounded, before they close; later
 * work is dropped quietly. An idle plugin store handle does not block writers.
 */
export async function closeServeContext(
  context: ServeContextEnd,
  closePluginStore: (store: unknown) => void,
): Promise<void> {
  await context.views.drain();
  await context.views.close();
  closePluginStore(context.registry.store);
  await context.log.close();
}
