import { ActionIcon, Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconHistory, IconSettings } from '@tabler/icons-react';
import { useSession, type ConnectionState } from '../store/session';
import classes from './Header.module.css';

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  unknown: 'Not checked yet',
  checking: 'Connecting…',
  ok: 'Connected',
  loading: 'Server is loading the voice model',
  auth: 'API key needed',
  error: 'Server unreachable',
};

function ConnectionDot() {
  const connection = useSession((s) => s.connection);
  const message = useSession((s) => s.connectionMessage);
  const openDrawer = useSession((s) => s.openDrawer);
  const label = message ? `${CONNECTION_LABEL[connection]}: ${message}` : CONNECTION_LABEL[connection];
  return (
    <Tooltip label={label} multiline maw={280}>
      <ActionIcon
        size={44}
        radius="xl"
        variant="subtle"
        color="gray"
        aria-label={`Connection: ${label}. Open settings`}
        onClick={() => openDrawer('settings', { focusApiKey: connection === 'auth' })}
        data-testid="connection-dot"
      >
        <span className={classes.dot} data-state={connection} />
      </ActionIcon>
    </Tooltip>
  );
}

/** Sticky app header: brand mark + wordmark, connection state, history and settings. */
export function Header() {
  const openDrawer = useSession((s) => s.openDrawer);
  const setView = useSession((s) => s.setView);
  return (
    <header className={classes.header} data-app-header>
      <Group justify="space-between" wrap="nowrap" className={classes.inner}>
        <UnstyledButton
          className={classes.brand}
          onClick={() => setView('compose')}
          aria-label="Tamber home"
        >
          <span className="tamber-mark" style={{ width: 30 }} aria-hidden />
          <Text component="span" fw={800} fz={22} lts={-0.5} className="tamber-gradient-text">
            Tamber
          </Text>
        </UnstyledButton>
        <Group gap={2} wrap="nowrap">
          <ConnectionDot />
          <Tooltip label="Recent texts">
            <ActionIcon
              size={44}
              radius="xl"
              color="gray"
              aria-label="Recent texts"
              onClick={() => openDrawer('history')}
            >
              <IconHistory size={22} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Settings">
            <ActionIcon
              size={44}
              radius="xl"
              color="gray"
              aria-label="Settings"
              onClick={() => openDrawer('settings')}
              data-testid="open-settings"
            >
              <IconSettings size={22} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
    </header>
  );
}
