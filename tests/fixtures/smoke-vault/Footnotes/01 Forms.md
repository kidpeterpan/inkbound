---
title: Footnote Fixture
author: Inkbound CI
language: en
---

# Forms of footnote

Numbered[^1], named[^named], inline^[an inline note], repeated[^1] and once more[^1].

- A list item with a note[^list].

| Column | Other |
|--------|-------|
| a cell[^cell] | plain |

> [!note] A callout
> A note inside a callout[^callout].

> A quotation with a note[^quote].

## A heading with a note[^head]

A note with several paragraphs[^multi], one with a link[^link], one with typeset math[^math] and one with an image[^image].

[^1]: The first note, referred to three times.
[^named]: A named note.
[^list]: A note on a list item.
[^cell]: A note in a table cell.
[^callout]: A note in a callout.
[^quote]: A note in a quotation.
[^head]: A note on a heading.
[^multi]: First paragraph of a note that has two.

    Second paragraph of the same note.
[^link]: See [[02 Embeds]] for the embedded case.
[^math]: The value $x^2$ is a square.
[^image]: A picture: ![pixel](pixel.png)
