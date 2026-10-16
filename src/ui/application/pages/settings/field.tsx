import { Input } from '../../../primitives/input';
import { Textarea } from '../../../primitives/textarea';

export function field(
  label: string,
  id: string,
  value: string | number,
  type = 'text',
  help = '',
  cls = ''
) {
  return (
    <div className={`field ${cls}`}>
      <label htmlFor={id}>{label}</label>
      {type === 'textarea' ? (
        <Textarea id={id} className="code-field" spellCheck="false" defaultValue={value} />
      ) : (
        <Input id={id} type={type} defaultValue={value} autoComplete="off" />
      )}
      {help ? <small>{help}</small> : ''}
    </div>
  );
}
