const fmt = (level: string) => {
  const ts = new Date().toISOString().slice(11, 19);
  return `[${ts}] [${level}]`;
};

export const log = {
  info: (msg: string, ...args: unknown[]) => console.log(fmt('INFO'), msg, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(fmt('WARN'), msg, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(fmt('ERR'), msg, ...args),
  debug: (msg: string, ...args: unknown[]) => {
    if (process.env.DEBUG) console.log(fmt('DBG'), msg, ...args);
  },
};
