import { Text } from '@mantine/core';
import type { PlayerState } from '../lib/messages';
import { statusText } from '../lib/format';

export function StatusLine({ state }: { state: PlayerState }) {
  return (
    <Text size="xs" c={state.status === 'error' ? 'red' : 'dimmed'} fw={500} truncate>
      {statusText(state)}
    </Text>
  );
}
