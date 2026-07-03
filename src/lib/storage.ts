import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Alert } from 'react-native';
import { supabase, supabaseUrl, supabaseAnonKey } from './supabase';
import { withTimeout } from './withTimeout';

export type StorageBucket = 'avatars' | 'vehicles';
export type PrivateStorageBucket = 'driver-verification';

/**
 * Faz o upload de um arquivo local para o Storage via `fetch` cru + FormData.
 *
 * Por que NÃO usamos `supabase.storage.upload()`:
 *   No React Native, o caminho de upload do supabase-js envia o corpo como
 *   ArrayBuffer (`decode(base64)`), o que TRAVA de forma intermitente no
 *   dispositivo (bug conhecido de RN/iOS com corpos binários). O envio via
 *   FormData com `{ uri, name, type }` faz o streaming nativo do arquivo direto
 *   do disco — sem ArrayBuffer, sem base64 — e é o padrão que funciona.
 *
 * Replica a mesma abordagem comprovada do `edgeFunction.ts`: pega um token
 * fresco com `getSession()` e dispara um `fetch` manual (com timeout).
 */
async function uploadToStorage(
  bucket: string,
  fileName: string,
  fileUri: string,
): Promise<void> {
  const { data: { session } } = await withTimeout(
    supabase.auth.getSession(),
    10000,
    'Não foi possível validar sua sessão. Tente novamente.',
  );
  const token = session?.access_token;
  if (!token) throw new Error('Sessão expirada. Faça login novamente.');

  const form = new FormData();
  // O cast é necessário: o tipo DOM de FormData não conhece o formato
  // { uri, name, type } que o React Native usa para streaming de arquivo.
  form.append('file', { uri: fileUri, name: fileName, type: 'image/jpeg' } as unknown as Blob);

  const res = await withTimeout(
    fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${fileName}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
        'x-upsert': 'true',
        // NÃO definir Content-Type: o fetch injeta o boundary do multipart.
      },
      body: form,
    }),
    20000,
    'O envio da foto demorou demais. Verifique sua conexão e tente novamente.',
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Falha no upload (${res.status}). ${detail}`.trim());
  }
}

/**
 * Abre a galeria (ou câmera) e devolve um URI local já comprimido.
 * Retorna null se o usuário cancelar ou negar a permissão.
 */
export async function pickImage(options?: {
  fromCamera?: boolean;
  aspect?: [number, number];
}): Promise<string | null> {
  const { fromCamera = false, aspect } = options ?? {};

  // Permissões
  if (fromCamera) {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permissão necessária', 'Autorize o acesso à câmera para tirar a foto.');
      return null;
    }
  } else {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permissão necessária', 'Autorize o acesso às fotos para selecionar a imagem.');
      return null;
    }
  }

  const result = fromCamera
    ? await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect,
        quality: 0.9,
      })
    : await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect,
        quality: 0.9,
      });

  if (result.canceled || !result.assets?.[0]) return null;
  return result.assets[0].uri;
}

/**
 * Comprime/redimensiona a imagem e faz upload para o bucket informado.
 * Devolve a URL pública do arquivo.
 *
 * @param bucket   'avatars' | 'vehicles'
 * @param uri      URI local da imagem (vindo de pickImage)
 * @param pathPrefix  pasta dentro do bucket — normalmente o id do usuário
 */
export async function uploadImage(
  bucket: StorageBucket,
  uri: string,
  pathPrefix: string
): Promise<string> {
  // Redimensiona para no máx. 1080px de largura e converte para JPEG.
  // Com timeout: sem isso, uma manipulação presa (raro, mas acontece em
  // arquivos HEIC grandes) deixava o spinner de upload girando para sempre.
  const manipulated = await withTimeout(
    ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1080 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
    ),
    15000,
    'Não foi possível processar a imagem a tempo. Tente novamente.'
  );

  const fileName = `${pathPrefix}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.jpg`;

  await uploadToStorage(bucket, fileName, manipulated.uri);

  const { data } = supabase.storage.from(bucket).getPublicUrl(fileName);
  return data.publicUrl;
}

/**
 * Mesma compressão/upload de uploadImage, mas para buckets PRIVADOS — devolve
 * o caminho interno do arquivo (não uma URL pública, que não existiria), já
 * que o acesso a esses arquivos só é concedido via signed URL gerada no
 * backend (ver Edge Function admin-driver-verification).
 */
export async function uploadPrivateImage(
  bucket: PrivateStorageBucket,
  uri: string,
  pathPrefix: string
): Promise<string> {
  const manipulated = await withTimeout(
    ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1080 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
    ),
    15000,
    'Não foi possível processar a imagem a tempo. Tente novamente.'
  );

  const fileName = `${pathPrefix}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.jpg`;

  await uploadToStorage(bucket, fileName, manipulated.uri);

  return fileName;
}

/** Atalho: escolher uma imagem e já subir para o storage. */
export async function pickAndUpload(
  bucket: StorageBucket,
  pathPrefix: string,
  options?: { fromCamera?: boolean; aspect?: [number, number] }
): Promise<string | null> {
  const uri = await pickImage(options);
  if (!uri) return null;
  return uploadImage(bucket, uri, pathPrefix);
}
