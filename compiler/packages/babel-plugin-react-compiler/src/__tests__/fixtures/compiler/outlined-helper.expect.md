
## Input

```javascript
function Component(props) {
  return (
    <div>
      {props.items.map((item) => (
        <Item item={item} />
      ))}
    </div>
  );
}

```

## Code

```javascript
import { c as _c } from "react/compiler-runtime";
function Component(props) {
  const $ = _c(4);
  let t0;
  if ($[0] !== props.items) {
    t0 = props.items.map(_temp);
    $[0] = props.items;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  let t1;
  if ($[2] !== t0) {
    t1 = <div>{t0}</div>;
    $[2] = t0;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  return t1;
}
function _temp(item) {
  return <Item item={item} />;
}

```
      
### Eval output
(kind: exception) Fixture not implemented