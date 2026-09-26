/** In-memory expo-secure-store for Jest. */
export const __store = new Map<string, string>();

export const getItemAsync = jest.fn(async (key: string) => __store.get(key) ?? null);
export const setItemAsync = jest.fn(async (key: string, value: string) => {
  __store.set(key, value);
});
export const deleteItemAsync = jest.fn(async (key: string) => {
  __store.delete(key);
});
