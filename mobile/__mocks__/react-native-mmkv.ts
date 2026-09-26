/** In-memory react-native-mmkv v4 (createMMKV) for Jest. */
export interface MMKV {
  set(key: string, value: string | number | boolean): void;
  getString(key: string): string | undefined;
  remove(key: string): boolean;
  contains(key: string): boolean;
  getAllKeys(): string[];
  clearAll(): void;
}

export const __instances = new Map<string, Map<string, string | number | boolean>>();

export function createMMKV(config?: { id?: string }): MMKV {
  const id = config?.id ?? 'mmkv.default';
  const data = __instances.get(id) ?? new Map<string, string | number | boolean>();
  __instances.set(id, data);
  return {
    set: (k, v) => {
      data.set(k, v);
    },
    getString: (k) => {
      const v = data.get(k);
      return typeof v === 'string' ? v : undefined;
    },
    remove: (k) => data.delete(k),
    contains: (k) => data.has(k),
    getAllKeys: () => [...data.keys()],
    clearAll: () => data.clear(),
  };
}
