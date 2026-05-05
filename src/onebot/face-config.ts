import faceConfigData from './face-config.json';
import type { FaceConfigFile } from './types';

const faceMap: Map<string, string> = new Map(
  (faceConfigData as FaceConfigFile).sysface.map(entry => [entry.AQLid, entry.QDes]),
);

/** Look up a QQ face by its AQLid and return the QDes description (e.g. "/汪汪"). */
export const lookupFace = (aqlId: string): string | undefined =>
  faceMap.get(aqlId);
