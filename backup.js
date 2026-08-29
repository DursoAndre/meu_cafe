import { coffeeIdentity } from "./db.js";
import { validateCoffeeImport } from "./validation.js";

const BACKUP_VERSION = "1.0.0";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_PHOTO_BYTES = 20 * 1024 * 1024;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function serializePhoto(photo) {
  if (!photo) return null;
  return {
    name: photo.name,
    type: photo.type,
    data: await blobToDataUrl(photo.blob),
  };
}

function decodePhoto(photo, path, errors, budget) {
  if (photo === null) return null;
  if (
    !photo ||
    typeof photo !== "object" ||
    typeof photo.name !== "string" ||
    !IMAGE_TYPES.has(photo.type) ||
    typeof photo.data !== "string"
  ) {
    errors.push(`${path} é inválida.`);
    return null;
  }
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(
    photo.data,
  );
  if (!match || match[1] !== photo.type) {
    errors.push(`${path} contém formato ou MIME inválido.`);
    return null;
  }
  try {
    const encoded = match[2].replace(/\s/g, "");
    const estimatedBytes =
      Math.floor((encoded.length * 3) / 4) -
      (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    if (estimatedBytes > MAX_PHOTO_BYTES) {
      errors.push(`${path} excede 6 MB.`);
      return null;
    }
    if (budget.total + estimatedBytes > MAX_TOTAL_PHOTO_BYTES) {
      errors.push("As fotos do backup excedem 20 MB.");
      return null;
    }
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    budget.total += binary.length;
    return {
      name: photo.name.slice(0, 200),
      type: photo.type,
      blob: new Blob([bytes], { type: photo.type }),
    };
  } catch {
    errors.push(`${path} contém base64 inválido.`);
    return null;
  }
}

export async function createBackup(items) {
  const totalPhotoBytes = items.reduce(
    (total, item) =>
      total +
      (item.photos.packagePhoto?.blob.size ?? 0) +
      (item.photos.cardPhoto?.blob.size ?? 0),
    0,
  );
  if (totalPhotoBytes > MAX_TOTAL_PHOTO_BYTES) {
    throw new Error(
      "As fotos excedem 20 MB. Faça backups mais frequentes e reduza fotos antigas.",
    );
  }
  const coffees = [];
  for (const item of items) {
    coffees.push({
      import_data: item.record.import_data,
      rating: item.record.rating,
      comment: item.record.comment,
      status: item.record.status,
      created_at: item.record.created_at,
      updated_at: item.record.updated_at,
      photos: {
        package: await serializePhoto(item.photos.packagePhoto),
        card: await serializePhoto(item.photos.cardPhoto),
      },
    });
  }
  return {
    backup_version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    coffees,
  };
}

export async function saveBackup(backup) {
  const date = new Date().toISOString().slice(0, 10);
  const file = new File([JSON.stringify(backup)], `meu-cafe-backup-${date}.json`, {
    type: "application/json",
  });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "Backup do Meu Café",
      });
      return true;
    } catch (error) {
      if (error.name === "AbortError") return false;
    }
  }

  const blob = file;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `meu-cafe-backup-${date}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return window.confirm(
    "Confirme somente depois de verificar que o arquivo foi salvo em Files, iCloud Drive, Google Drive ou Downloads.",
  );
}

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function parseBackup(value) {
  const errors = [];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.backup_version !== BACKUP_VERSION ||
    !Array.isArray(value.coffees)
  ) {
    return {
      valid: false,
      errors: ["O arquivo não é um backup compatível do Meu Café."],
      items: [],
    };
  }
  if (value.coffees.length > 500) errors.push("O backup excede 500 cafés.");

  const budget = { total: 0 };
  const items = [];
  value.coffees.slice(0, 500).forEach((coffee, index) => {
    const path = `coffees[${index}]`;
    const validation = validateCoffeeImport(coffee?.import_data);
    if (!validation.valid) {
      errors.push(`${path}: ${validation.errors[0]}`);
      return;
    }
    if (
      coffee.rating !== null &&
      (!Number.isInteger(coffee.rating) || coffee.rating < 0 || coffee.rating > 5)
    ) {
      errors.push(`${path}.rating é inválida.`);
    }
    if (typeof coffee.comment !== "string" || coffee.comment.length > 4000) {
      errors.push(`${path}.comment é inválido.`);
    }
    if (!["active", "finished"].includes(coffee.status)) {
      errors.push(`${path}.status é inválido.`);
    }

    const packagePhoto = decodePhoto(
      coffee.photos?.package ?? null,
      `${path}.photos.package`,
      errors,
      budget,
    );
    const cardPhoto = decodePhoto(
      coffee.photos?.card ?? null,
      `${path}.photos.card`,
      errors,
      budget,
    );

    const now = new Date().toISOString();
    const id =
      crypto.randomUUID?.() ??
      `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
    items.push({
      record: {
        id,
        identity: coffeeIdentity(coffee.import_data),
        import_data: coffee.import_data,
        rating: coffee.rating,
        comment: coffee.comment,
        status: coffee.status,
        has_package_photo: Boolean(packagePhoto),
        has_card_photo: Boolean(cardPhoto),
        created_at: validTimestamp(coffee.created_at) ? coffee.created_at : now,
        updated_at: validTimestamp(coffee.updated_at) ? coffee.updated_at : now,
      },
      photos: {
        coffeeId: id,
        packagePhoto,
        cardPhoto,
      },
    });
  });

  return { valid: errors.length === 0, errors, items };
}

export async function readBackupFile(file) {
  if (!file || file.size > 30 * 1024 * 1024) {
    throw new Error("O arquivo de backup é inválido ou muito grande.");
  }
  let value;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error("O arquivo não contém JSON válido.");
  }
  return parseBackup(value);
}

