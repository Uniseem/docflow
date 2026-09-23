import { Button, Header, Label, ListBox, Select } from '@heroui/react'
import { groupedTranslators, type TranslatorOption } from '../lib/translators'

export function TranslatorSelect(props: {
  options: TranslatorOption[]
  selectedKey: string | null
  onChange: (key: string) => void
  label?: string
  isDisabled?: boolean
  emptyLabel?: string
}) {
  const groups = groupedTranslators(props.options)
  const empty = props.options.length === 0
  return (
    <Select
      // value/onChange is the documented controlled API; selectedKey/onSelectionChange are
      // deprecated aliases in react-stately.
      value={empty ? null : props.selectedKey}
      onChange={(key) => {
        if (typeof key === 'string') props.onChange(key)
      }}
      placeholder={empty ? (props.emptyLabel ?? '尚未添加') : '请选择模型'}
      isDisabled={Boolean(props.isDisabled) || empty}
      // Only fall back to aria-label without a visible <Label>: RAC stops wiring the Label
      // slot to the trigger as soon as aria-label is present.
      {...(props.label ? {} : { 'aria-label': '翻译模型' })}
    >
      {props.label ? <Label>{props.label}</Label> : null}
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {groups.map((group) => (
            <ListBox.Section key={group.id}>
              <Header>{group.name}</Header>
              {group.items.map((item) => (
                <ListBox.Item key={item.key} id={item.key} textValue={item.label}>
                  {item.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox.Section>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

export function RevealLabel({ platform }: { platform: 'darwin' | 'win32' | undefined }) {
  return platform === 'win32' ? '在文件资源管理器中显示' : '在访达中显示'
}

export { Button }
