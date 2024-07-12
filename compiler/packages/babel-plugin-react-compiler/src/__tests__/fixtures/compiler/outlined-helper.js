function Component(props) {
  return (
    <div>
      {props.items.map((item) => (
        <Item item={item} />
      ))}
    </div>
  );
}
