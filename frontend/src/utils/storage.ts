export const readStorage = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const writeStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
};

export const removeStorage = (key: string) => {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
};

