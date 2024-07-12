
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
  const $ = _c(5);
  let t0;
  if ($[0] !== props.items) {
    let t1;
    if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = (item) => <Item item={item} />;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    t0 = props.items.map(t1);
    $[0] = props.items;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  let t1;
  if ($[3] !== t0) {
    t1 = <div>{t0}</div>;
    $[3] = t0;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  return t1;
}

```
      
### Eval output
(kind: exception) Fixture not implemented