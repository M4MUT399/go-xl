import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { decode } from 'base64-arraybuffer';
import { Alert } from 'react-native';
import { supabase } from './supabase';
import { withTimeout } from './withTimeout';

export type StorageBucket = 'avatars' | 'vehicles';
export type PrivateStorageBucket = 'driver-verification';

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
  // Redimensiona para no máx. 1080px de largura e converte para JPEG (base64).
  // Com timeout: sem isso, uma manipulação presa (raro, mas acontece em
  // arquivos HEIC grandes) deixava o spinner de upload girando para sempre.
  const manipulated = await withTimeout(
    ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1080 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    ),
    15000,
    'Não foi possível processar a imagem a tempo. Tente novamente.'
  );

  if (!manipulated.base64) throw new Error('Falha ao processar a imagem.');

  const fileName = `${pathPrefix}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.jpg`;

  // Com timeout: o upload para o Storage é a chamada de rede mais pesada
  // desse fluxo — sem prazo, rede lenta/instável travava a tela indefinidamente.
  const { error } = await withTimeout(
    supabase.storage
      .from(bucket)
      .upload(fileName, decode(manipulated.base64), {
        contentType: 'image/jpeg',
        upsert: true,
      }),
    20000,
    'O envio da foto demorou demais. Verifique sua conexão e tente novamente.'
  );

  if (error) throw error;

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
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    ),
    15000,
    'Não foi possível processar a imagem a tempo. Tente novamente.'
  );

  if (!manipulated.base64) throw new Error('Falha ao processar a imagem.');

  const fileName = `${pathPrefix}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.jpg`;

  const { error } = await withTimeout(
    supabase.storage
      .from(bucket)
      .upload(fileName, decode(manipulated.base64), {
        contentType: 'image/jpeg',
        upsert: true,
      }),
    20000,
    'O envio da foto demorou demais. Verifique sua conexão e tente novamente.'
  );

  if (error) throw error;
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
