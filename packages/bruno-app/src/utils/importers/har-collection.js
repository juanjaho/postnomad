import { BrunoError } from 'utils/common/error';
import { harToBruno } from '@usebruno/converters';

export const convertHarToBruno = (data) => {
  try {
    return harToBruno(data);
  } catch (err) {
    console.error('Error converting HAR to Postnomad:', err);
    throw new BrunoError('Import collection failed: ' + err.message);
  }
};

export const isHarFile = (data) => {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const log = data.log;
  if (!log || typeof log !== 'object') {
    return false;
  }
  if (typeof log.version !== 'string') {
    return false;
  }
  if (!Array.isArray(log.entries)) {
    return false;
  }
  // Sanity: at least one entry should look like a HAR request.
  if (log.entries.length === 0) {
    return true;
  }
  const first = log.entries[0];
  return !!(first && first.request && typeof first.request.url === 'string');
};
