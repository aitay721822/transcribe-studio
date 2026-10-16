let closeCurrent: () => void = () => {};

export function closeDropdown() {
  closeCurrent();
}

export function registerDropdown(close: () => void) {
  closeCurrent();
  closeCurrent = close;
  return () => {
    if (closeCurrent === close) closeCurrent = () => {};
  };
}
