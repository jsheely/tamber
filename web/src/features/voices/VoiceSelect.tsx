import { Select, type SelectProps } from '@mantine/core';
import { useState } from 'react';

/**
 * A searchable voice picker that behaves like a combo box on touch screens: opening it focuses
 * the field and clears the search, so typing filters the list right away instead of appending to
 * the selected voice's label. Closing restores the selected label.
 */
export function VoiceSelect(props: Omit<SelectProps, 'searchable' | 'searchValue' | 'onSearchChange'>) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const label = props.data
    ? (props.data as { group?: string; items?: { value: string; label: string }[]; value?: string; label?: string }[])
        .flatMap((d) => ('items' in d && d.items ? d.items : [d as { value: string; label: string }]))
        .find((o) => o.value === props.value)?.label ?? ''
    : '';
  return (
    <Select
      {...props}
      searchable
      selectFirstOptionOnChange
      searchValue={open ? search : label}
      onSearchChange={setSearch}
      onDropdownOpen={() => {
        setSearch('');
        setOpen(true);
        props.onDropdownOpen?.();
      }}
      onDropdownClose={() => {
        setOpen(false);
        setSearch('');
        props.onDropdownClose?.();
      }}
      comboboxProps={{ withinPortal: true, zIndex: 1000, ...props.comboboxProps }}
    />
  );
}
