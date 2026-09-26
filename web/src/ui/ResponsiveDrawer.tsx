import { Drawer, type DrawerProps } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';

/** Bottom sheet on phones, side panel from md (62em) up. */
export function ResponsiveDrawer({ children, ...props }: Omit<DrawerProps, 'position' | 'size'>) {
  const desktop = useMediaQuery('(min-width: 62em)', true, { getInitialValueInEffect: false });
  return (
    <Drawer
      {...props}
      position={desktop ? 'right' : 'bottom'}
      size={desktop ? 460 : '88%'}
      radius={desktop ? 0 : 'xl'}
      styles={{
        content: desktop
          ? undefined
          : { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, paddingBottom: 'var(--tamber-safe-bottom)' },
        header: { zIndex: 5 },
        title: { fontWeight: 700, fontSize: 'var(--mantine-font-size-lg)' },
      }}
    >
      {children}
    </Drawer>
  );
}
