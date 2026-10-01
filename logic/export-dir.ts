// Where exported files are written, remembered across sessions.
//
// The DICOM database is usually SERVED (the app's own /_db route), not opened from a granted folder,
// so there is no directory handle to write an exported SEG into. Asking for one with a file dialog
// every time is the clicking this was meant to avoid, so it is asked ONCE and kept: the File System
// Access API's handles survive in IndexedDB, and the permission survives with them for the origin.
//
// Separate from the database directory on purpose. Writing into the database's own tree without
// adding the matching rows to ctkDICOM.sql would leave files the index does not know about, which is
// the kind of half-state that is worse than an obvious extra folder.
const IDB_NAME = "sliceralbula-export";
const IDB_STORE = "handles";
const KEY = "exportDir";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function rememberExportDir(dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(dir, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* private mode, or no IndexedDB: the folder is simply asked for again next time */ }
}

/**
 * The remembered export folder, with write permission, or null.
 *
 * `prompt` is what separates a silent reuse from re-asking: permission may have lapsed (a browser
 * restart), and re-requesting it needs a user gesture, so only a call made from a click passes true.
 */
export async function recallExportDir(opts: { prompt?: boolean } = {}): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await idb();
    const dir = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const get = tx.objectStore(IDB_STORE).get(KEY);
      get.onsuccess = () => resolve(get.result as FileSystemDirectoryHandle | undefined);
      get.onerror = () => reject(get.error);
    });
    if (!dir) return null;
    const p = dir as unknown as { queryPermission?: (o: unknown) => Promise<string>; requestPermission?: (o: unknown) => Promise<string> };
    let state = await p.queryPermission?.({ mode: "readwrite" }) ?? "granted";
    if (state !== "granted" && opts.prompt) state = await p.requestPermission?.({ mode: "readwrite" }) ?? "denied";
    return state === "granted" ? dir : null;
  } catch {
    return null;
  }
}
