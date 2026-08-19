export type CameraCredentials = {
  username: string;
  password: string;
};

export async function loadCameraCredentials(): Promise<CameraCredentials> {
  const password = process.env.CAMERA_PASSWORD;
  const username = process.env.CAMERA_USERNAME ?? "admin";
  if (!/^[\u0021-\u007e]+$/.test(username) || !password) {
    throw new Error("CAMERA_PASSWORD and a valid CAMERA_USERNAME are required");
  }
  return { username, password };
}
