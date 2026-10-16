/** Base64 transport bytes are not prose; retain original image parts outside summaries. */
export function textContext(value: unknown) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'string' && item.startsWith('data:image/')
      ? '[image attachment retained in original input]'
      : item
  );
}
