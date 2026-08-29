const DB_NAME = "meu-cafe-catalog";
const DB_VERSION = 2;

let databasePromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Operação cancelada."));
  });
}

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        databasePromise = null;
        reject(error);
      };
      request.onupgradeneeded = (event) => {
        const db = request.result;
        let coffees;
        if (!db.objectStoreNames.contains("coffees")) {
          coffees = db.createObjectStore("coffees", { keyPath: "id" });
          coffees.createIndex("identity", "identity", { unique: true });
          coffees.createIndex("created_at", "created_at");
        } else {
          coffees = request.transaction.objectStore("coffees");
        }
        if (!db.objectStoreNames.contains("photos")) {
          db.createObjectStore("photos", { keyPath: "coffeeId" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
        if (event.oldVersion === 1) {
          const migratedIdentities = new Set();
          const cursorRequest = coffees.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const record = cursor.value;
            const identity = coffeeIdentity(record.import_data);
            record.identity = migratedIdentities.has(identity)
              ? `${identity}#${record.id}`
              : identity;
            migratedIdentities.add(identity);
            cursor.update(record);
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        db.onversionchange = () => {
          db.close();
          databasePromise = null;
        };
        resolve(db);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () =>
        fail(new Error("Feche outras abas do Meu Café e tente novamente."));
    });
  }
  return databasePromise;
}

function normalized(value) {
  return (value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("pt-BR");
}

function newId() {
  return (
    crypto.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`
  );
}

export function coffeeIdentity(importData) {
  const coffee = importData.coffee;
  return JSON.stringify([
    normalized(coffee.name),
    normalized(coffee.roaster),
    coffee.roast_date ?? "",
  ]);
}

async function nextRevision(metaStore) {
  const current = await requestResult(metaStore.get("revision"));
  const revision = (current?.value ?? 0) + 1;
  metaStore.put({ key: "revision", value: revision });
  return revision;
}

export async function addCoffee(importData, photos) {
  const db = await openDatabase();
  const transaction = db.transaction(["coffees", "photos", "meta"], "readwrite");
  const coffees = transaction.objectStore("coffees");
  const identity = coffeeIdentity(importData);
  const existingId = await requestResult(coffees.index("identity").getKey(identity));
  if (existingId) {
    transaction.abort();
    throw new Error("Este café parece já estar cadastrado.");
  }

  const now = new Date().toISOString();
  const record = {
    id: newId(),
    identity,
    import_data: importData,
    rating: null,
    comment: "",
    status: "active",
    has_package_photo: Boolean(photos.packagePhoto),
    has_card_photo: Boolean(photos.cardPhoto),
    created_at: now,
    updated_at: now,
  };
  coffees.add(record);
  transaction.objectStore("photos").add({
    coffeeId: record.id,
    packagePhoto: photos.packagePhoto ?? null,
    cardPhoto: photos.cardPhoto ?? null,
  });
  await nextRevision(transaction.objectStore("meta"));
  await transactionDone(transaction);
  return record;
}

export async function listCoffees() {
  const db = await openDatabase();
  const transaction = db.transaction("coffees", "readonly");
  const records = await requestResult(transaction.objectStore("coffees").getAll());
  await transactionDone(transaction);
  return records.sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export async function getCoffee(id) {
  const db = await openDatabase();
  const transaction = db.transaction(["coffees", "photos"], "readonly");
  const [record, photos] = await Promise.all([
    requestResult(transaction.objectStore("coffees").get(id)),
    requestResult(transaction.objectStore("photos").get(id)),
  ]);
  await transactionDone(transaction);
  if (!record) throw new Error("Café não encontrado.");
  return { ...record, photos: photos ?? { packagePhoto: null, cardPhoto: null } };
}

export async function updateCoffee(id, changes, baseUpdatedAt) {
  const allowed = new Set(["rating", "comment", "status"]);
  const unknown = Object.keys(changes).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Campos inválidos: ${unknown.join(", ")}.`);
  if (
    changes.rating !== null &&
    (!Number.isInteger(changes.rating) || changes.rating < 0 || changes.rating > 5)
  ) {
    throw new Error("A nota deve ser inteira entre 0 e 5.");
  }
  if (typeof changes.comment !== "string" || changes.comment.length > 4000) {
    throw new Error("Comentário inválido ou muito longo.");
  }
  if (!["active", "finished"].includes(changes.status)) {
    throw new Error("Status inválido.");
  }

  const db = await openDatabase();
  const transaction = db.transaction(["coffees", "meta"], "readwrite");
  const store = transaction.objectStore("coffees");
  const record = await requestResult(store.get(id));
  if (!record) {
    transaction.abort();
    throw new Error("Café não encontrado.");
  }
  if (baseUpdatedAt && record.updated_at !== baseUpdatedAt) {
    transaction.abort();
    throw new Error("Este café foi alterado em outra aba. Reabra a ficha e tente novamente.");
  }
  Object.assign(record, changes, { updated_at: new Date().toISOString() });
  store.put(record);
  await nextRevision(transaction.objectStore("meta"));
  await transactionDone(transaction);
  return record;
}

export async function readBackupData() {
  const db = await openDatabase();
  const transaction = db.transaction(["coffees", "photos", "meta"], "readonly");
  const [coffees, photos, revision] = await Promise.all([
    requestResult(transaction.objectStore("coffees").getAll()),
    requestResult(transaction.objectStore("photos").getAll()),
    requestResult(transaction.objectStore("meta").get("revision")),
  ]);
  await transactionDone(transaction);
  const photosByCoffee = new Map(photos.map((item) => [item.coffeeId, item]));
  return {
    revision: revision?.value ?? 0,
    items: coffees.map((record) => ({
      record,
      photos: photosByCoffee.get(record.id) ?? {
        coffeeId: record.id,
        packagePhoto: null,
        cardPhoto: null,
      },
    })),
  };
}

export async function importBackupData(items, conflictStrategy = "keep") {
  const db = await openDatabase();
  const transaction = db.transaction(["coffees", "photos", "meta"], "readwrite");
  const coffees = transaction.objectStore("coffees");
  const photos = transaction.objectStore("photos");
  const existing = await requestResult(coffees.getAll());
  const recordsByIdentity = new Map(existing.map((record) => [record.identity, record]));
  let imported = 0;
  let skipped = 0;
  let replaced = 0;

  for (const item of items) {
    const current = recordsByIdentity.get(item.record.identity);
    if (current) {
      if (conflictStrategy !== "replace") {
        skipped += 1;
        continue;
      }
      const replacement = {
        ...item.record,
        id: current.id,
        identity: current.identity,
      };
      coffees.put(replacement);
      photos.put({ ...item.photos, coffeeId: current.id });
      replaced += 1;
      continue;
    }
    coffees.add(item.record);
    photos.add({ ...item.photos, coffeeId: item.record.id });
    recordsByIdentity.set(item.record.identity, item.record);
    imported += 1;
  }
  if (imported > 0 || replaced > 0) await nextRevision(transaction.objectStore("meta"));
  await transactionDone(transaction);
  return { imported, replaced, skipped };
}

export async function deleteCoffee(id, baseUpdatedAt) {
  const db = await openDatabase();
  const transaction = db.transaction(["coffees", "photos", "meta"], "readwrite");
  const record = await requestResult(transaction.objectStore("coffees").get(id));
  if (!record) {
    transaction.abort();
    throw new Error("Café não encontrado.");
  }
  if (baseUpdatedAt && record.updated_at !== baseUpdatedAt) {
    transaction.abort();
    throw new Error("Este café foi alterado em outra aba. Reabra a ficha e tente novamente.");
  }
  transaction.objectStore("coffees").delete(id);
  transaction.objectStore("photos").delete(id);
  await nextRevision(transaction.objectStore("meta"));
  await transactionDone(transaction);
}

export async function backupState() {
  const db = await openDatabase();
  const transaction = db.transaction("meta", "readonly");
  const [revision, backedUpRevision] = await Promise.all([
    requestResult(transaction.objectStore("meta").get("revision")),
    requestResult(transaction.objectStore("meta").get("backedUpRevision")),
  ]);
  await transactionDone(transaction);
  return {
    revision: revision?.value ?? 0,
    backedUpRevision: backedUpRevision?.value ?? 0,
  };
}

export async function markBackedUp(revision) {
  const db = await openDatabase();
  const transaction = db.transaction("meta", "readwrite");
  const store = transaction.objectStore("meta");
  store.put({ key: "backedUpRevision", value: revision });
  store.put({ key: "lastBackupAt", value: new Date().toISOString() });
  await transactionDone(transaction);
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}

