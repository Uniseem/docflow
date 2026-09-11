using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using DocFlow.Services;

namespace DocFlow.ViewModels;

public sealed partial class LibraryViewModel : ObservableObject
{
    private EngineClient? _engine;
    private int _loadGeneration;

    public ObservableCollection<DocumentItemViewModel> Items { get; } = [];

    [ObservableProperty]
    public partial string Filter { get; set; } = "all";

    [ObservableProperty]
    public partial string Query { get; set; } = "";

    [ObservableProperty]
    public partial StatusCounts Counts { get; set; } = new();

    [ObservableProperty]
    public partial bool IsLoading { get; set; }

    [ObservableProperty]
    public partial bool IsEmpty { get; set; }

    [ObservableProperty]
    public partial bool IsLibraryEmpty { get; set; }

    [ObservableProperty]
    public partial string? Error { get; set; }

    public void Attach()
    {
        Detach();
        _engine = AppHost.Engine;
        if (_engine is null)
        {
            return;
        }
        _engine.DocumentChanged += OnDocumentChanged;
        _engine.DocumentRemoved += OnDocumentRemoved;
        _engine.EventReceived += OnEvent;
    }

    public void Detach()
    {
        if (_engine is null)
        {
            return;
        }
        _engine.DocumentChanged -= OnDocumentChanged;
        _engine.DocumentRemoved -= OnDocumentRemoved;
        _engine.EventReceived -= OnEvent;
        _engine = null;
    }

    public async Task LoadAsync()
    {
        if (!AppHost.IsReady)
        {
            return;
        }
        var generation = ++_loadGeneration;
        IsLoading = true;
        Error = null;
        try
        {
            var list = await AppHost.RequireEngine().CallAsync<DocumentList>(
                "documents.list",
                new { filter = Filter, query = Query });
            if (generation != _loadGeneration)
            {
                return;
            }
            Counts = list.Counts;
            Synchronize(list.Items);
        }
        catch (EngineException error)
        {
            Error = error.Message;
        }
        finally
        {
            if (generation == _loadGeneration)
            {
                IsLoading = false;
                UpdateEmpty();
            }
        }
    }

    /// <summary>Updates rows in place so selection and scroll position survive.</summary>
    private void Synchronize(List<DocumentInfo> documents)
    {
        var existing = Items.ToDictionary(item => item.Id);
        for (var index = 0; index < documents.Count; index++)
        {
            var document = documents[index];
            if (existing.Remove(document.Id, out var item))
            {
                item.Update(document);
                var current = Items.IndexOf(item);
                if (current != index)
                {
                    Items.Move(current, index);
                }
            }
            else
            {
                Items.Insert(index, new DocumentItemViewModel(document));
            }
        }
        foreach (var stale in existing.Values)
        {
            Items.Remove(stale);
        }
    }

    private bool Matches(DocumentInfo document)
    {
        var filter = Filter switch
        {
            "active" => document.IsActive,
            "completed" => document.Status == "completed",
            "failed" => document.Status is "failed" or "cancelled",
            _ => true,
        };
        return filter
            && (string.IsNullOrWhiteSpace(Query)
                || document.Title.Contains(Query, StringComparison.CurrentCultureIgnoreCase)
                || document.OriginalFilename.Contains(Query, StringComparison.CurrentCultureIgnoreCase));
    }

    private async void OnDocumentChanged(string id)
    {
        try
        {
            var engine = AppHost.RequireEngine();
            var document = await engine.CallAsync<DocumentInfo>("documents.get", new { id });
            var item = Items.FirstOrDefault(candidate => candidate.Id == id);
            if (Matches(document))
            {
                if (item is null)
                {
                    Items.Insert(0, new DocumentItemViewModel(document));
                }
                else
                {
                    item.Update(document);
                }
            }
            else if (item is not null)
            {
                Items.Remove(item);
            }
            Counts = (await engine.CallAsync<DocumentList>("documents.list", new { limit = 1 })).Counts;
            UpdateEmpty();
        }
        catch (EngineException)
        {
            // The document may have been deleted in the meantime.
        }
    }

    private async void OnDocumentRemoved(string id)
    {
        var item = Items.FirstOrDefault(candidate => candidate.Id == id);
        if (item is not null)
        {
            Items.Remove(item);
        }
        try
        {
            Counts = (await AppHost.RequireEngine().CallAsync<DocumentList>("documents.list", new { limit = 1 })).Counts;
        }
        catch (EngineException)
        {
        }
        UpdateEmpty();
    }

    private void OnEvent(ProcessingEvent processingEvent)
    {
        Items.FirstOrDefault(item => item.Id == processingEvent.DocumentId)?.Apply(processingEvent);
    }

    private void UpdateEmpty()
    {
        IsEmpty = Items.Count == 0 && !IsLoading;
        IsLibraryEmpty = Counts.All == 0;
    }
}
