import { type ReactNode, useState } from 'react';

type DropdownProps = {
  label: string;
  children: ReactNode;
};

export function Dropdown({ label, children }: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="dropdown">
      <button
        className="dropdown-toggle"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        {label}
      </button>
      {isOpen ? (
        <div className="dropdown-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}
