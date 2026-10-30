import type { ReactElement } from "react";

import { ChoiceGroup } from "../../components/ChoiceGroup";
import { FormField } from "../../components/FormField";
import {
  TAG_PALETTE,
  tagColorPresentation,
} from "../../components/tags/tagColorPresentation";

export function TagPaletteField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (color: string) => void;
}): ReactElement {
  const presentation = tagColorPresentation(value);
  return (
    <FormField label="Colour">
      <ChoiceGroup
        dataTestId={id}
        legend="Tag colour"
        value={value}
        options={TAG_PALETTE.map((color) => ({
          value: color.id,
          label: (
            <>
              <span
                className="tag-palette-swatch"
                style={{ background: color.bg }}
                aria-hidden="true"
              />
              <span>{color.label}</span>
            </>
          ),
        }))}
        onChange={onChange}
        className="tag-palette"
        optionClassName="tag-palette-option"
      />
      {presentation.legacy ? (
        <div className="notice tag-legacy-color-notice" role="status">
          <strong>Legacy colour</strong>
          <span>
            The stored value {JSON.stringify(value)} is shown as neutral slate.
            Choose a supported colour only if you want to replace it.
          </span>
        </div>
      ) : null}
    </FormField>
  );
}
