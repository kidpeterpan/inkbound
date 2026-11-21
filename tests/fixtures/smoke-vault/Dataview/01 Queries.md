# Queries

## Backtick fence

```dataview
LIST FROM "Dataview"
```

## DataviewJS

```dataviewjs
dv.list([1, 2])
```

## Tilde fence

~~~dataview
LIST FROM "Dataview"
~~~

## Four backticks

````dataview
LIST FROM "Dataview"
````

## Trailing spaces

```dataview   
LIST FROM "Dataview"
```

## Trailing word

```dataview extra
LIST FROM "Dataview"
```

## Three-space indent

   ```dataview
   LIST FROM "Dataview"
   ```

## In a callout

> [!note] In a callout
> ```dataview
> LIST FROM "Dataview"
> ```

## In a nested quote

> [!note] Nested
> > ```dataview
> > LIST FROM "Dataview"
> > ```

## In a list item

- An item with a query:

    ```dataview
    LIST FROM "Dataview"
    ```

## Right after a paragraph line

Paragraph text right before a fence.
```dataview
LIST FROM "Dataview"
```

## A code sample that shows a query

````markdown
```dataview
SAMPLE-QUERY-MUST-SURVIVE
```
````

## Capital D is a code block

```Dataview
CAPITAL-D-MUST-SURVIVE
```

## Indented code

Paragraph before indented code.

    ```dataview
    INDENTED-MUST-SURVIVE
    ```

## Unclosed at the end

```dataview
LIST FROM "Dataview"
